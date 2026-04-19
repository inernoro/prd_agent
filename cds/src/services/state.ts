import path from 'node:path';
import crypto from 'node:crypto';
import type { CdsState, BranchEntry, BuildProfile, BuildProfileOverride, RoutingRule, OperationLog, InfraService, ExecutorNode, DataMigration, CdsPeer, Project, AgentKey, GlobalAgentKey, CustomEnvStore } from '../types.js';
import { GLOBAL_ENV_SCOPE } from '../types.js';
import type { StateBackingStore } from '../infra/state-store/backing-store.js';
import { JsonStateBackingStore, MAX_STATE_BACKUPS as JSON_MAX_BACKUPS } from '../infra/state-store/json-backing-store.js';
import { sealToken, unsealToken, isSealedSecret } from '../infra/secret-seal.js';

const MAX_LOGS_PER_BRANCH = 10;
/** Max rolling backups of state.json kept on disk. Re-exported from the backing store so existing callers keep working. */
const MAX_STATE_BACKUPS = JSON_MAX_BACKUPS;

function emptyState(): CdsState {
  return {
    routingRules: [],
    buildProfiles: [],
    branches: {},
    nextPortIndex: 0,
    logs: {},
    defaultBranch: null,
    customEnv: { [GLOBAL_ENV_SCOPE]: {} } as CustomEnvStore,
    infraServices: [],
    previewMode: 'multi',
  };
}

/**
 * In-place migration: pre-2026-04-18 state.json stored customEnv as a
 * flat `Record<string, string>`. The new shape is
 * `Record<string, Record<string, string>>` keyed by scope (reserved
 * `_global` + any projectId). This wraps the legacy flat object into
 * `{ _global: <old> }` on load so existing data keeps working without
 * touching the on-disk file until the next save.
 *
 * Detection rule: if ANY top-level value is a string (or anything
 * non-object), treat the whole thing as the legacy flat form. This
 * tolerates the odd `customEnv: null / undefined / ""` shapes seen
 * during development.
 */
function migrateCustomEnv(raw: unknown): CustomEnvStore {
  if (!raw || typeof raw !== 'object') {
    return { [GLOBAL_ENV_SCOPE]: {} };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  const isLegacyFlat = entries.some(([, v]) => typeof v !== 'object' || v === null);
  if (isLegacyFlat) {
    const flat: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (typeof v === 'string') flat[k] = v;
    }
    // Log once per boot so operators grepping cds.log can confirm the
    // migration fired exactly once on first startup after upgrade.
    // eslint-disable-next-line no-console
    console.log(
      `[state] migrated legacy customEnv into _global scope (${Object.keys(flat).length} vars)`,
    );
    return { [GLOBAL_ENV_SCOPE]: flat };
  }
  // Already nested. Ensure _global exists so callers can rely on it.
  const out: CustomEnvStore = {};
  for (const [scope, vars] of entries) {
    const bucket: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
      if (typeof v === 'string') bucket[k] = v;
    }
    out[scope] = bucket;
  }
  if (!out[GLOBAL_ENV_SCOPE]) out[GLOBAL_ENV_SCOPE] = {};
  return out;
}

export class StateService {
  private state: CdsState = emptyState();
  private readonly filePath: string;
  /** P3: the persistence seam. Mutable — setBackingStore() swaps it
   *  at runtime for the "switch storage mode" flow in the Settings
   *  panel (P4 Part 18 D.3). */
  private backingStore: StateBackingStore;
  /** Project slug derived from repoRoot directory name, used for cache isolation */
  readonly projectSlug: string;

  constructor(filePath: string, repoRoot?: string, backingStore?: StateBackingStore) {
    this.filePath = filePath;
    // Derive project slug from repoRoot (e.g. /root/inernoro/prd_agent → prd-agent)
    const dirName = path.basename(repoRoot || path.dirname(path.dirname(filePath)));
    this.projectSlug = dirName.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'default';
    // Default backing store is the JSON implementation that preserves
    // the pre-P3 on-disk format (atomic write + rolling backups). P4
    // Part 18 Phase D allows injecting MongoStateBackingStore here
    // when CDS_STORAGE_MODE=mongo, and supports runtime swaps via
    // setBackingStore().
    this.backingStore = backingStore ?? new JsonStateBackingStore(filePath);
  }

  /**
   * P4 Part 18 (D.3): swap the backing store at runtime. Used by the
   * "switch storage mode" flow in the Settings panel to go from
   * json → mongo without restarting CDS. The new backing store must
   * already be initialized (for mongo, init() must have resolved)
   * AND must contain the caller's current state — typically the
   * caller will do `newStore.seedIfEmpty(stateService.getState())`
   * before calling this, so the mongo write path has the up-to-date
   * snapshot.
   *
   * After this call every subsequent save() goes to the new store.
   * The old store is NOT closed here; callers are responsible for
   * tearing it down if needed (usually file-based stores just let
   * the fd go out of scope).
   */
  setBackingStore(next: StateBackingStore): void {
    this.backingStore = next;
  }

  /**
   * P4 Part 18 (D.3): expose the current backing store so the
   * Settings panel API can surface its `kind` tag and — when the
   * store is mongo — call flush() / isHealthy() without having to
   * import the concrete class here.
   */
  getBackingStore(): StateBackingStore {
    return this.backingStore;
  }

  static slugify(branch: string): string {
    return branch
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
  }

  load(): void {
    // P3: delegate to the backing store. JsonStateBackingStore preserves
    // the legacy file-I/O + .bak.* recovery semantics; Mongo/DualWrite
    // stores land in P3 Part 2/3.
    const loaded = this.backingStore.load();
    if (loaded) {
      this.state = loaded;
      // Migrate older state files
      if (!this.state.logs) this.state.logs = {};
      if (!this.state.routingRules) this.state.routingRules = [];
      if (!this.state.buildProfiles) this.state.buildProfiles = [];
      if (this.state.defaultBranch === undefined) this.state.defaultBranch = null;
      // Shape migration: legacy flat Record<string,string> → scoped
      // { _global, <projectId> } store. Runs every load — idempotent when
      // the state is already nested. See migrateCustomEnv() in this file.
      this.state.customEnv = migrateCustomEnv(this.state.customEnv);
      if (!this.state.infraServices) this.state.infraServices = [];
      if (this.state.mirrorEnabled === undefined) this.state.mirrorEnabled = false;
      if (this.state.tabTitleEnabled === undefined) this.state.tabTitleEnabled = true;
      if (this.state.previewMode === undefined) this.state.previewMode = 'multi';
      if (!this.state.executors) this.state.executors = {};
      if (!this.state.dataMigrations) this.state.dataMigrations = [];
      if (!this.state.cdsPeers) this.state.cdsPeers = [];
      if (!this.state.projects) this.state.projects = [];
      // Migrate: backfill cacheMounts for existing build profiles
      this.migrateCacheMounts();
      // Migrate: ensure deployModes field exists on profiles (no-op if already present)
      this.migrateDeployModes();
      // Migrate: ensure at least one "legacy default" project exists to
      // wrap all pre-P4 data. See migrateProjects() for the rules.
      this.migrateProjects();
      // Migrate: tag every pre-P4 branch/profile/infra/routing entry with
      // the legacy default projectId. See migrateProjectScoping().
      this.migrateProjectScoping();
    } else {
      this.state = emptyState();
      // Fresh install still needs a default project so the UI has
      // something to render on the first boot.
      this.migrateProjects();
      // (nothing to scope on a fresh install — collections are empty)
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

  /**
   * P4 Part 1 migration: ensure at least one Project exists.
   *
   * CDS v3.2 had no concept of projects — state.json was implicitly
   * single-tenant. v4 introduces multi-project support, but we never
   * want to drop pre-existing data during upgrade. So on first load
   * after the upgrade, we create a "legacy default" project that
   * wraps everything and mark it with legacyFlag=true.
   *
   * The legacy project derives its name/slug from StateService.projectSlug
   * so multi-CDS deployments with different repoRoot directories don't
   * accidentally share a project name. If projects already exist (either
   * from a prior migration run or because Part 2 let the user create
   * them), this method is a no-op.
   *
   * Real project CRUD arrives in P4 Part 2, which will replace the
   * hardcoded 'default' id with proper UUIDs.
   */
  private migrateProjects(): void {
    if (!this.state.projects) this.state.projects = [];
    if (this.state.projects.length > 0) return;

    const now = new Date().toISOString();
    this.state.projects.push({
      id: 'default',
      slug: this.projectSlug,
      name: this.projectSlug,
      description: '默认项目 — 由 P4 Part 1 迁移自动创建，包含所有 v3.2 时期的分支和配置',
      kind: 'git',
      legacyFlag: true,
      createdAt: now,
      updatedAt: now,
    });
    this.save();
  }

  /**
   * P4 Part 3a migration: stamp every existing branch / build profile /
   * infra service / routing rule with the legacy default projectId
   * ('default') so that consumers can filter by project without
   * special-casing pre-P4 data.
   *
   * Idempotent: entries already carrying a projectId are left alone.
   * This lets the migration run safely on every boot, even after
   * P4 Part 2 users start creating non-legacy projects (their entries
   * will already have projectId set by the route that creates them).
   *
   * Invariant enforced after this runs: every branch / profile / infra /
   * rule has a non-empty projectId. Part 3b can then rely on that
   * invariant to add projectId filter middleware without null checks.
   */
  private migrateProjectScoping(): void {
    const legacyId = 'default';
    let changed = false;

    // Branches
    for (const branch of Object.values(this.state.branches || {})) {
      if (!branch.projectId) {
        branch.projectId = legacyId;
        changed = true;
      }
    }
    // Build profiles
    for (const profile of this.state.buildProfiles || []) {
      if (!profile.projectId) {
        profile.projectId = legacyId;
        changed = true;
      }
    }
    // Infra services
    for (const infra of this.state.infraServices || []) {
      if (!infra.projectId) {
        infra.projectId = legacyId;
        changed = true;
      }
    }
    // Routing rules
    for (const rule of this.state.routingRules || []) {
      if (!rule.projectId) {
        rule.projectId = legacyId;
        changed = true;
      }
    }

    if (changed) this.save();
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
    // P3: delegate physical persistence to the backing store. The atomic
    // write + .bak.* rotation semantics that used to live inline now live
    // in JsonStateBackingStore.save(); swapping to MongoStateBackingStore
    // in P3 Part 2 keeps this code path untouched.
    this.backingStore.save(this.state);

    // Notify listeners (this is *not* part of the backing store contract
    // because listeners are a StateService concern — they run after
    // logical state changes, not every physical write).
    for (const fn of this.onSaveListeners) {
      try { fn(); } catch { /* ignore */ }
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
    // P4 Part 3a: stamp a default projectId when the caller didn't set
    // one so the project-scoped queries always have a value to match.
    if (!entry.projectId) entry.projectId = 'default';
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
    // P4 Part 3a: default projectId for the legacy path.
    if (!rule.projectId) rule.projectId = 'default';
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
    if (!profile.projectId) profile.projectId = 'default';
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

  // ── Projects (P4 Part 1: read-only list, Part 2 adds mutation) ──

  /**
   * Returns the full projects list. After migration runs during load(),
   * this is guaranteed to have at least one entry (the legacy default).
   */
  getProjects(): Project[] {
    return this.state.projects || [];
  }

  /** Look up a project by id. Returns undefined when not found. */
  getProject(id: string): Project | undefined {
    return (this.state.projects || []).find((p) => p.id === id);
  }

  /**
   * Find the "legacy default" project — the one migrateProjects() created
   * for pre-P4 data. There is at most one of these per CdsState.
   *
   * Helper for the projects router which needs a stable fallback when
   * an API path that carries no projectId is hit. P4 Part 3 replaces the
   * fallback with an explicit projectId filter on every caller.
   */
  getLegacyProject(): Project | undefined {
    return (this.state.projects || []).find((p) => p.legacyFlag === true);
  }

  /**
   * Add a new project. Will be used by P4 Part 2 when the real
   * `POST /api/projects` endpoint is wired up. Part 1 only ships the
   * method (no HTTP surface) so tests can exercise the storage layer
   * without waiting for Part 2's route work.
   */
  addProject(project: Project): void {
    if (!this.state.projects) this.state.projects = [];
    if (this.state.projects.some((p) => p.id === project.id)) {
      throw new Error(`Project with id '${project.id}' already exists`);
    }
    if (this.state.projects.some((p) => p.slug === project.slug)) {
      throw new Error(`Project with slug '${project.slug}' already exists`);
    }
    this.state.projects.push(project);
    this.save();
  }

  /**
   * Remove a project by id. The legacy default project cannot be
   * removed — it is the anchor for pre-P4 data and deleting it would
   * orphan every branch/profile/infra entry.
   *
   * P4 Part 17 (G8 fix): cascade-removes branches, build profiles,
   * infra services, and routing rules that belong to this project.
   * Container teardown still happens at the route layer (it needs
   * docker shell access); this method just keeps state.json clean.
   *
   * Returns a summary of what was removed so the caller (route) can
   * report it to the operator.
   */
  removeProject(id: string): {
    branches: string[];
    buildProfiles: string[];
    infraServices: string[];
    routingRules: string[];
  } {
    if (!this.state.projects) {
      return { branches: [], buildProfiles: [], infraServices: [], routingRules: [] };
    }
    const project = this.state.projects.find((p) => p.id === id);
    if (!project) {
      return { branches: [], buildProfiles: [], infraServices: [], routingRules: [] };
    }
    if (project.legacyFlag) {
      throw new Error('Cannot remove the legacy default project');
    }

    // ── Cascade collection (compute before mutating) ──
    // Use the explicit projectId match; we DO NOT want to also catch
    // entries with a missing projectId (those belong to the legacy
    // default project and must not be removed).
    const branchesToRemove = Object.values(this.state.branches || {})
      .filter((b) => b.projectId === id)
      .map((b) => b.id);
    const buildProfilesToRemove = (this.state.buildProfiles || [])
      .filter((p) => p.projectId === id)
      .map((p) => p.id);
    const infraServicesToRemove = (this.state.infraServices || [])
      .filter((s) => s.projectId === id)
      .map((s) => s.id);
    const routingRulesToRemove = (this.state.routingRules || [])
      .filter((r) => r.projectId === id)
      .map((r) => r.id);

    // ── Cascade mutate ──
    for (const bid of branchesToRemove) {
      delete this.state.branches[bid];
      // Also drop any operation logs tied to this branch — reuse the
      // existing removeLogs() helper which knows the storage layout.
      this.removeLogs(bid);
    }
    if (this.state.buildProfiles) {
      this.state.buildProfiles = this.state.buildProfiles.filter((p) => p.projectId !== id);
    }
    if (this.state.infraServices) {
      this.state.infraServices = this.state.infraServices.filter((s) => s.projectId !== id);
    }
    if (this.state.routingRules) {
      this.state.routingRules = this.state.routingRules.filter((r) => r.projectId !== id);
    }
    // Drop this project's customEnv scope too so a deleted project doesn't
    // leave behind a dangling bucket that would revive on re-create with
    // the same id. _global is never removed.
    this.dropCustomEnvScope(id);

    this.state.projects = this.state.projects.filter((p) => p.id !== id);
    this.save();

    return {
      branches: branchesToRemove,
      buildProfiles: buildProfilesToRemove,
      infraServices: infraServicesToRemove,
      routingRules: routingRulesToRemove,
    };
  }

  /**
   * Patch an existing project's mutable fields. Used by future rename /
   * description-edit UI in P4 Part 2, and by P4 Part 18 (G1) to record
   * the async clone lifecycle (repoPath / cloneStatus / cloneError).
   */
  updateProject(
    id: string,
    updates: Partial<
      Pick<
        Project,
        | 'name'
        | 'aliasName'
        | 'aliasSlug'
        | 'description'
        | 'gitRepoUrl'
        | 'repoPath'
        | 'cloneStatus'
        | 'cloneError'
        | 'githubRepoFullName'
        | 'githubInstallationId'
        | 'githubAutoDeploy'
        | 'githubLinkedAt'
        | 'autoSmokeEnabled'
      >
    >,
  ): void {
    if (!this.state.projects) return;
    const idx = this.state.projects.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const current = this.state.projects[idx];
    this.state.projects[idx] = {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }

  /**
   * Find a project linked to the given GitHub repository (case-insensitive
   * "owner/repo" match). Used by the webhook dispatcher when a `push` or
   * `check_run` event arrives — the repo full_name is the only identifier
   * GitHub gives us that stays stable across renames within an org.
   *
   * Returns undefined when no project is linked. A repo linked to multiple
   * projects shouldn't happen in practice (the link endpoint refuses that),
   * but this picks the first match defensively.
   */
  findProjectByRepoFullName(repoFullName: string): Project | undefined {
    const needle = repoFullName.toLowerCase();
    return (this.state.projects || []).find(
      (p) => p.githubRepoFullName?.toLowerCase() === needle,
    );
  }

  /**
   * Patch the GitHub-related fields of a branch in-place. Separated from
   * `updateBranchMeta` because those fields are orthogonal (user-facing
   * vs system-managed) and we don't want a typo in the webhook handler
   * to accidentally null out user notes.
   */
  updateBranchGithubMeta(
    id: string,
    updates: {
      githubRepoFullName?: string;
      githubCommitSha?: string;
      githubCheckRunId?: number;
      githubInstallationId?: number;
      githubPrNumber?: number;
      githubPreviewCommentId?: number;
    },
  ): void {
    const branch = this.state.branches[id];
    if (!branch) return;
    // Use `in updates` rather than `!== undefined` so explicit
    // `{ githubCheckRunId: undefined }` can CLEAR a stamped field
    // (used by the orphan-reconciliation startup routine to drop stale
    // check-run ids after marking them as neutral on GitHub).
    if ('githubRepoFullName' in updates) branch.githubRepoFullName = updates.githubRepoFullName;
    if ('githubCommitSha' in updates) branch.githubCommitSha = updates.githubCommitSha;
    if ('githubCheckRunId' in updates) branch.githubCheckRunId = updates.githubCheckRunId;
    if ('githubInstallationId' in updates) branch.githubInstallationId = updates.githubInstallationId;
    if ('githubPrNumber' in updates) branch.githubPrNumber = updates.githubPrNumber;
    if ('githubPreviewCommentId' in updates) branch.githubPreviewCommentId = updates.githubPreviewCommentId;
  }

  // ── Project-scoped Agent Keys ──
  //
  // Each AgentKey stores only the sha256 of the plaintext key; the key
  // prefix (`cdsp_<slugHead12>_...`) encodes the owning project so the
  // auth middleware can look up the project from the header alone.
  // Plaintext is shown once at signing time and never persisted.

  /** Append an AgentKey entry under a project. Creates the array on demand. */
  addAgentKey(projectId: string, entry: AgentKey): void {
    if (!this.state.projects) return;
    const idx = this.state.projects.findIndex((p) => p.id === projectId);
    if (idx < 0) throw new Error(`Project '${projectId}' not found`);
    const project = this.state.projects[idx];
    if (!project.agentKeys) project.agentKeys = [];
    project.agentKeys.push(entry);
    project.updatedAt = new Date().toISOString();
    this.save();
  }

  /** List all AgentKey entries for a project (revoked entries included for audit). */
  getAgentKeys(projectId: string): AgentKey[] {
    const project = (this.state.projects || []).find((p) => p.id === projectId);
    return project?.agentKeys || [];
  }

  /**
   * Mark a key revoked. Keeps the entry so the audit trail (who signed,
   * when, last used) survives. Returns true on match, false otherwise.
   */
  revokeAgentKey(projectId: string, keyId: string): boolean {
    if (!this.state.projects) return false;
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project?.agentKeys) return false;
    const entry = project.agentKeys.find((k) => k.id === keyId);
    if (!entry) return false;
    if (!entry.revokedAt) {
      entry.revokedAt = new Date().toISOString();
      project.updatedAt = new Date().toISOString();
      this.save();
    }
    return true;
  }

  /**
   * Parse an incoming plaintext key `cdsp_<slugHead12>_<suffix>` and find
   * the matching non-revoked AgentKey across all projects. Uses
   * timingSafeEqual for hash comparison so the endpoint doesn't leak
   * hash bytes via timing.
   *
   * Returns null on any failure (malformed prefix, unknown slug, no
   * matching hash, key revoked).
   */
  findAgentKeyForAuth(plaintextKey: string): { projectId: string; keyId: string } | null {
    if (!plaintextKey || !plaintextKey.startsWith('cdsp_')) return null;
    // Strict shape: cdsp_<slugHead>_<suffix>
    const parts = plaintextKey.split('_');
    if (parts.length < 3) return null;
    const slugHead = parts[1].toLowerCase();
    if (!slugHead) return null;
    const hash = crypto.createHash('sha256').update(plaintextKey).digest('hex');
    const hashBuf = Buffer.from(hash, 'hex');
    for (const project of this.state.projects || []) {
      const projectSlugHead = project.slug.slice(0, 12).toLowerCase();
      if (projectSlugHead !== slugHead) continue;
      for (const entry of project.agentKeys || []) {
        if (entry.revokedAt) continue;
        try {
          const entryBuf = Buffer.from(entry.hash, 'hex');
          if (entryBuf.length !== hashBuf.length) continue;
          if (crypto.timingSafeEqual(entryBuf, hashBuf)) {
            return { projectId: project.id, keyId: entry.id };
          }
        } catch {
          /* malformed hash in state, skip */
        }
      }
    }
    return null;
  }

  /** Best-effort lastUsedAt stamp. Silent on unknown ids — not worth throwing. */
  touchAgentKeyLastUsed(projectId: string, keyId: string): void {
    const project = (this.state.projects || []).find((p) => p.id === projectId);
    const entry = project?.agentKeys?.find((k) => k.id === keyId);
    if (!entry) return;
    entry.lastUsedAt = new Date().toISOString();
    // Save is best-effort — a failed save here shouldn't block the request.
    try { this.save(); } catch { /* ignore */ }
  }

  // ── Global (bootstrap-equivalent) Agent Keys ──
  //
  // Parallels the project-scoped key storage above but lives at the top
  // level so findAgentKeyForAuth and assertProjectAccess don't treat
  // these as project-scoped. Intended for onboarding a new Agent that
  // needs to create a brand-new project (project-scoped keys cannot).
  // The UI must show a loud warning before issuing one.

  /** Append a GlobalAgentKey. Creates the top-level array on demand. */
  addGlobalAgentKey(entry: GlobalAgentKey): void {
    if (!this.state.globalAgentKeys) this.state.globalAgentKeys = [];
    this.state.globalAgentKeys.push(entry);
    this.save();
  }

  /** List all GlobalAgentKey entries (revoked entries included for audit). */
  getGlobalAgentKeys(): GlobalAgentKey[] {
    return this.state.globalAgentKeys || [];
  }

  /**
   * Mark a global key revoked. Keeps the entry so the audit trail
   * (who signed, when, last used) survives. Returns true on match,
   * false otherwise.
   */
  revokeGlobalAgentKey(keyId: string): boolean {
    if (!this.state.globalAgentKeys) return false;
    const entry = this.state.globalAgentKeys.find((k) => k.id === keyId);
    if (!entry) return false;
    if (!entry.revokedAt) {
      entry.revokedAt = new Date().toISOString();
      this.save();
    }
    return true;
  }

  /**
   * Parse an incoming plaintext `cdsg_<suffix>` and find the matching
   * non-revoked GlobalAgentKey. Parallels findAgentKeyForAuth but
   * without the project lookup step — all global keys live in one
   * array. Returns null on any failure.
   */
  findGlobalAgentKeyForAuth(plaintextKey: string): { keyId: string } | null {
    if (!plaintextKey || !plaintextKey.startsWith('cdsg_')) return null;
    const hash = crypto.createHash('sha256').update(plaintextKey).digest('hex');
    const hashBuf = Buffer.from(hash, 'hex');
    for (const entry of this.state.globalAgentKeys || []) {
      if (entry.revokedAt) continue;
      try {
        const entryBuf = Buffer.from(entry.hash, 'hex');
        if (entryBuf.length !== hashBuf.length) continue;
        if (crypto.timingSafeEqual(entryBuf, hashBuf)) {
          return { keyId: entry.id };
        }
      } catch {
        /* malformed hash in state, skip */
      }
    }
    return null;
  }

  /** Best-effort lastUsedAt stamp on a global key. Silent on unknown id. */
  touchGlobalAgentKeyLastUsed(keyId: string): void {
    const entry = (this.state.globalAgentKeys || []).find((k) => k.id === keyId);
    if (!entry) return;
    entry.lastUsedAt = new Date().toISOString();
    try { this.save(); } catch { /* ignore */ }
  }

  // ── Pending imports (agent-submitted CDS compose awaiting approval) ──

  getPendingImports(): import('../types.js').PendingImport[] {
    return this.state.pendingImports || [];
  }

  getPendingImport(id: string): import('../types.js').PendingImport | undefined {
    return (this.state.pendingImports || []).find((p) => p.id === id);
  }

  addPendingImport(item: import('../types.js').PendingImport): void {
    if (!this.state.pendingImports) this.state.pendingImports = [];
    this.state.pendingImports.push(item);
    this.save();
  }

  updatePendingImport(
    id: string,
    updates: Partial<import('../types.js').PendingImport>,
  ): void {
    const list = this.state.pendingImports || [];
    const idx = list.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error(`Pending import '${id}' not found`);
    list[idx] = { ...list[idx], ...updates };
    this.save();
  }

  /**
   * Prune decided imports older than `olderThanMs` so the state file
   * doesn't grow forever. Called lazily from the list endpoint when
   * the decided count exceeds a small threshold.
   */
  prunePendingImports(olderThanMs: number): number {
    const list = this.state.pendingImports;
    if (!list || list.length === 0) return 0;
    const now = Date.now();
    const kept = list.filter((p) => {
      if (p.status === 'pending') return true;
      if (!p.decidedAt) return true;
      return now - new Date(p.decidedAt).getTime() < olderThanMs;
    });
    const dropped = list.length - kept.length;
    if (dropped > 0) {
      this.state.pendingImports = kept;
      this.save();
    }
    return dropped;
  }

  /**
   * P4 Part 18 (Phase E): GitHub Device Flow token accessors.
   *
   * The token lives in state.githubDeviceAuth as a single-slot
   * snapshot (one GitHub connection per CDS install). Orthogonal
   * to auth-service which runs the CDS session flow.
   */
  getGithubDeviceAuth(): import('../types.js').GitHubDeviceAuth | undefined {
    const stored = this.state.githubDeviceAuth;
    if (!stored) return undefined;
    // FU-05: if the token field was sealed (AES-256-GCM) on the way
    // in, unseal it here so consumers always see plaintext. Legacy
    // plaintext tokens short-circuit in unsealToken(). Decryption
    // failures (key rotated, key removed, tampered state.json) are
    // logged and returned as "no auth" so the UI can re-prompt.
    const rawToken = (stored as { token: unknown }).token;
    if (isSealedSecret(rawToken)) {
      try {
        const plain = unsealToken(rawToken);
        return { ...stored, token: plain } as import('../types.js').GitHubDeviceAuth;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          '[state] failed to unseal github device token (CDS_SECRET_KEY rotated?):',
          (err as Error).message,
        );
        return undefined;
      }
    }
    return stored;
  }
  /**
   * UF-01 hardening: set + persist, then await the backing store flush
   * (no-op for JsonBackingStore which is sync, real await for
   * MongoStateBackingStore whose save() is write-behind). Callers on
   * the Device Flow completion path use this to guarantee the token
   * survives a CDS crash immediately after oauth — without the flush
   * the mongo upsert could still be in-flight when the user clicks
   * "clone" and a racing crash would lose the snapshot.
   *
   * Throws if the backing store save fails, so the caller (oauth
   * device-poll) can surface a real error to the UI instead of a
   * fake "ready" status.
   */
  async setGithubDeviceAuth(auth: import('../types.js').GitHubDeviceAuth | null): Promise<void> {
    if (auth) {
      // FU-05: seal the token field with AES-256-GCM before writing
      // to state.json. When CDS_SECRET_KEY is unset, sealToken() is
      // a no-op pass-through and we keep the legacy plaintext shape.
      // The rest of the envelope (login/name/avatarUrl/scopes) stays
      // unsealed so a leaked state.json still lets operators see
      // WHICH github account was connected, just not the token.
      const sealed = sealToken(auth.token);
      this.state.githubDeviceAuth = { ...auth, token: sealed as unknown as string };
    } else {
      delete this.state.githubDeviceAuth;
    }
    this.save();
    // If the backing store exposes a flush() method (Mongo write-behind),
    // await it so any upsert failure surfaces here rather than getting
    // swallowed on the async chain. JsonBackingStore has no flush(), so
    // this is a no-op there.
    const maybeFlush = (this.backingStore as { flush?: () => Promise<void> }).flush;
    if (typeof maybeFlush === 'function') {
      await maybeFlush.call(this.backingStore);
    }
  }

  /**
   * Resolve the absolute git repo root to use for operations on a given
   * project. Returns `project.repoPath` when set (post-G1 multi-repo),
   * else `fallback` (typically `CdsConfig.repoRoot` — the single host
   * bind-mounted repo that the legacy 'default' project has used since
   * day one).
   *
   * Centralizing this resolution in one helper means every worktree /
   * branch call-site can stay agnostic of whether a project has been
   * cloned into its own directory or is still piggy-backing on the
   * legacy repoRoot.
   *
   * When projectId is falsy (e.g. a pre-P4 branch with no projectId
   * field) we fall back to `fallback` directly — same reasoning as
   * getBranchesForProject treating missing projectId as 'default'.
   */
  getProjectRepoRoot(projectId: string | undefined, fallback: string): string {
    if (!projectId) return fallback;
    const project = this.getProject(projectId);
    return project?.repoPath || fallback;
  }

  // ── FU-04: worktree layout migration bookkeeping ──

  /** Current layout version stamped in state.json (undefined = legacy flat). */
  getWorktreeLayoutVersion(): number | undefined {
    return this.state.worktreeLayoutVersion;
  }

  /** Bump the stamp so subsequent boots skip the one-shot migration. */
  setWorktreeLayoutVersion(version: number): void {
    this.state.worktreeLayoutVersion = version;
  }

  /**
   * FU-04 helper: rewrite a branch's worktree path. Used by the
   * migration to point legacy entries at their new nested location
   * without going through the full updateBranchMeta() API (which
   * doesn't know about worktreePath, intentionally — it's a
   * structural field, not user metadata).
   */
  setBranchWorktreePath(branchId: string, worktreePath: string): void {
    const branch = this.state.branches[branchId];
    if (!branch) return;
    branch.worktreePath = worktreePath;
  }

  // ── Project-scoped views (P4 Part 3a) ──
  //
  // These helpers return slices of the existing collections filtered by
  // projectId. They are read-only wrappers; the underlying state.json
  // shape stays the same (flat collections), which means the existing
  // legacy code paths (getAllBranches / getBuildProfiles etc.) continue
  // to work unchanged. Part 3b adds project-scoped routes that call
  // these helpers via a middleware that injects `req.project`.
  //
  // Contract: a missing projectId on an entry is treated as 'default'.
  // The migration above ensures that case doesn't happen in practice,
  // but the helpers are defensive so unit tests can exercise them
  // against handcrafted state without running through load().

  getBranchesForProject(projectId: string): BranchEntry[] {
    return Object.values(this.state.branches || {}).filter(
      (b) => (b.projectId || 'default') === projectId,
    );
  }

  getBuildProfilesForProject(projectId: string): BuildProfile[] {
    return (this.state.buildProfiles || []).filter(
      (p) => (p.projectId || 'default') === projectId,
    );
  }

  getInfraServicesForProject(projectId: string): InfraService[] {
    return (this.state.infraServices || []).filter(
      (s) => (s.projectId || 'default') === projectId,
    );
  }

  getRoutingRulesForProject(projectId: string): RoutingRule[] {
    return (this.state.routingRules || []).filter(
      (r) => (r.projectId || 'default') === projectId,
    );
  }

  // ── Custom environment variables (scoped: _global + per-project) ──
  //
  // Storage lives in this.state.customEnv as a nested map:
  //   { _global: {...}, <projectId>: {...} }
  // Project scopes override _global at container launch time; a key set
  // in a project wins over the same key in _global.
  //
  // Callers usually fall into one of three cases:
  //   1. Startup / server-wide config  → pass nothing → global-only view
  //   2. Deploy path                   → pass projectId → merged view
  //                                      ({ ..._global, ...project })
  //   3. Settings UI                   → use the Raw accessor to read the
  //                                      full scoped map, or pass an
  //                                      explicit projectId to overwrite
  //                                      one bucket.

  /**
   * Merged custom env for a given scope.
   * - projectId omitted → just `_global` (pre-P4 behaviour)
   * - projectId supplied → `{ ..._global, ...project }` so project
   *   overrides win at deploy time.
   */
  getCustomEnv(projectId?: string): Record<string, string> {
    const store = this.state.customEnv || {};
    const global = store[GLOBAL_ENV_SCOPE] || {};
    if (!projectId || projectId === GLOBAL_ENV_SCOPE) {
      return { ...global };
    }
    const project = store[projectId] || {};
    return { ...global, ...project };
  }

  /** Full scoped map (for Settings UI). Never mutate the return value directly. */
  getCustomEnvRaw(): CustomEnvStore {
    if (!this.state.customEnv) this.state.customEnv = { [GLOBAL_ENV_SCOPE]: {} };
    if (!this.state.customEnv[GLOBAL_ENV_SCOPE]) this.state.customEnv[GLOBAL_ENV_SCOPE] = {};
    return this.state.customEnv;
  }

  /** Just one scope's vars (no merging). Returns empty object on unknown scope. */
  getCustomEnvScope(scope: string = GLOBAL_ENV_SCOPE): Record<string, string> {
    const bucket = (this.state.customEnv || {})[scope];
    return bucket ? { ...bucket } : {};
  }

  /** Replace the entire bucket for a scope. scope='_global' by default. */
  setCustomEnv(env: Record<string, string>, scope: string = GLOBAL_ENV_SCOPE): void {
    if (!this.state.customEnv) this.state.customEnv = { [GLOBAL_ENV_SCOPE]: {} };
    this.state.customEnv[scope] = { ...env };
  }

  /** Upsert a single var in the given scope. */
  setCustomEnvVar(key: string, value: string, scope: string = GLOBAL_ENV_SCOPE): void {
    if (!this.state.customEnv) this.state.customEnv = { [GLOBAL_ENV_SCOPE]: {} };
    if (!this.state.customEnv[scope]) this.state.customEnv[scope] = {};
    this.state.customEnv[scope][key] = value;
  }

  /** Remove a single var from the given scope. No-op when missing. */
  removeCustomEnvVar(key: string, scope: string = GLOBAL_ENV_SCOPE): void {
    const bucket = (this.state.customEnv || {})[scope];
    if (!bucket) return;
    delete bucket[key];
  }

  /** Drop an entire project bucket (used when a project is deleted). */
  dropCustomEnvScope(scope: string): void {
    if (!this.state.customEnv || scope === GLOBAL_ENV_SCOPE) return;
    delete this.state.customEnv[scope];
  }

  // ── Infrastructure services ──

  getInfraServices(): InfraService[] {
    return this.state.infraServices;
  }

  /**
   * Global-scope infra lookup — returns the FIRST match across all
   * projects. Kept for back-compat with legacy callers that don't
   * know the projectId (e.g. older Dashboard polls). New code should
   * prefer `getInfraServiceForProject(projectId, id)` so two projects
   * can each have their own `mongodb` without collision.
   */
  getInfraService(id: string): InfraService | undefined {
    return this.state.infraServices.find(s => s.id === id);
  }

  /**
   * Project-scoped infra lookup. Uses the composite key (projectId, id)
   * so the legacy project's `mongodb` and a fork project's `mongodb`
   * are distinct entries. A service with no projectId is treated as
   * belonging to the 'default' (legacy) project for back-compat.
   */
  getInfraServiceForProjectAndId(projectId: string, id: string): InfraService | undefined {
    return this.state.infraServices.find(
      s => s.id === id && (s.projectId || 'default') === projectId,
    );
  }

  addInfraService(service: InfraService): void {
    const projectId = service.projectId || 'default';
    // Uniqueness is (projectId, id), NOT just id — otherwise two
    // projects can't each register `mongodb`. This matches the
    // buildProfile uniqueness fix from commit 6a86b01.
    if (this.state.infraServices.some(s => s.id === service.id && (s.projectId || 'default') === projectId)) {
      throw new Error(`基础设施服务 "${service.id}" 在项目 "${projectId}" 中已存在`);
    }
    service.projectId = projectId;
    this.state.infraServices.push(service);
  }

  updateInfraService(id: string, updates: Partial<InfraService>, projectId?: string): void {
    // When projectId is supplied, scope the update to (projectId, id);
    // otherwise fall back to the legacy global find-first behaviour.
    const idx = projectId
      ? this.state.infraServices.findIndex(s => s.id === id && (s.projectId || 'default') === projectId)
      : this.state.infraServices.findIndex(s => s.id === id);
    if (idx === -1) throw new Error(`基础设施服务 "${id}" 不存在`);
    Object.assign(this.state.infraServices[idx], updates);
  }

  removeInfraService(id: string, projectId?: string): void {
    if (projectId) {
      this.state.infraServices = this.state.infraServices.filter(
        s => !(s.id === id && (s.projectId || 'default') === projectId),
      );
    } else {
      this.state.infraServices = this.state.infraServices.filter(s => s.id !== id);
    }
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
    // Docker host is a cross-project concern, read from the global scope.
    return (this.state.customEnv?.[GLOBAL_ENV_SCOPE] || {})['CDS_DOCKER_HOST']
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
