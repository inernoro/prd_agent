import type { BranchEntry, BranchPin, SchedulerConfig } from '../types.js';
import { createBranchPin, pinExpired, pinNeedsReview, reviewedConfigPin } from './branch-pin.js';
import type { StateService } from './state.js';
import { resolveBranchProtection } from './branch-protection.js';
import { resolvePreviewActivity, type PreviewActivityUnknownReason } from '../forwarder/preview-activity.js';
import { serviceRuntimeRefs } from './service-runtime.js';

/**
 * SchedulerService — branch warm-pool manager for small servers.
 *
 * Core idea: CDS does NOT keep every branch running forever. It maintains a
 * bounded "warm pool" of HOT branches. When a new branch needs to wake, if the
 * pool is full, the least-recently-accessed non-pinned branch is cooled down.
 * Idle branches become eligible after `idleTTLSeconds`; confirmed ample resources defer idle cooling.
 *
 * See `doc/design.cds.resilience.md` for the full design.
 *
 * Pinning rules (a branch is "pinned" and cannot be evicted if ANY apply):
 *   1. `branch.pinnedByUser === true`
 *   2. `branch.isColorMarked === true` (user is actively debugging)
 *   3. per-project defaultBranch === branch.id
 *   4. `config.pinnedBranches.includes(branch.id)`
 *   5. 主干分支（按 git 分支名判定，见 branch-protection.ts）
 * 判定实现是 `branch-protection.ts` 的 SSOT，janitor 消费同一份。
 *
 * Wake/cool is delegated via callbacks so the scheduler stays pure and testable:
 *   - `wakeFn(slug)` — bring a branch from COLD to HOT (returns when HOT)
 *   - `coolFn(slug)` — bring a branch from HOT to COLD (returns when stopped)
 *
 * The scheduler is a no-op when `config.enabled === false`, preserving pre-v3.1
 * behavior bit-for-bit.
 */

export interface PreviewActivityStatus {
  status: 'ready' | 'unknown';
  reason?: PreviewActivityUnknownReason;
  observedAt?: string;
  lastUnknownAt?: string;
  recoveryGraceRemainingMs: number;
}

export interface PreviewActivityTransition {
  status: 'ready' | 'unknown';
  reason?: PreviewActivityUnknownReason;
  observedAt: string;
  lastUnknownAt?: string;
}

export interface SchedulerSnapshot {
  enabled: boolean;
  config: SchedulerConfig;
  hot: Array<{ slug: string; lastAccessedAt: string | undefined; pinned: boolean }>;
  cold: Array<{ slug: string; lastAccessedAt: string | undefined }>;
  capacityUsage: { current: number; max: number };
  previewActivity?: PreviewActivityStatus;
  resourcePressure: 'ample' | 'pressure' | 'unknown';
  occupancy: Array<{ slug: string; state: 'resident' | 'reserved' | 'unknown' | 'nonresident'; reason: string }>;
  protections: Array<{ slug: string; source: string; active: boolean; reviewRequired: boolean; pin?: BranchPin }>;
}

export type WakeFn = (slug: string) => Promise<void>;
export type CoolFn = (slug: string) => Promise<void>;

/**
 * Minimal clock interface so tests can inject deterministic time.
 */
export interface Clock {
  now(): number;
  monotonicNow?(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/**
 * Minimum interval (ms) between persistent writes of lastAccessedAt from
 * touch(). High-traffic branches can get dozens of requests per second; we
 * don't need each one to hit disk. In-memory timestamps are always fresh.
 */
const TOUCH_PERSIST_THROTTLE_MS = 15_000;
const ACTIVITY_RECOVERY_GRACE_MS = 60_000;
export const MAX_HOT_BRANCHES = 25;

export class SchedulerService {
  private tickHandle: NodeJS.Timeout | null = null;
  private wakeFn: WakeFn | null = null;
  private coolFn: CoolFn | null = null;
  private runtimePresence?: () => ReadonlySet<string> | null;
  private operationProtection?: (slug: string) => boolean;
  private readonly cooling = new Set<string>();
  private readonly coolingTasks = new Map<string, Promise<void>>();
  private readonly waking = new Map<string, Promise<void>>();
  private readonly reservations = new Set<string>();
  private admission: Promise<unknown> = Promise.resolve();
  private tickInFlight?: Promise<void>;
  private pressure?: () => SchedulerSnapshot['resourcePressure'] | Promise<SchedulerSnapshot['resourcePressure']>;
  private observedPressure: SchedulerSnapshot['resourcePressure'] = 'unknown';
  /** slug → epoch ms of last persisted touch, used to throttle save() */
  private lastPersistedTouch = new Map<string, number>();
  private activitySource?: { read: () => Promise<unknown>; isProbe: (fingerprint: string) => boolean; masterStartedAt: number };
  private activityRefresh?: Promise<boolean>;
  private activityUnknown = false;
  private activityGraceDeadline?: number;
  private activityUnknownReported = false;
  private activityReason?: PreviewActivityUnknownReason;
  private activityObservedAt?: string;
  private activityLastUnknownAt?: string;
  private activityLastObservedStatus?: PreviewActivityStatus['status'];
  private activityTransition?: (event: PreviewActivityTransition) => void;

  constructor(
    private readonly stateService: StateService,
    private readonly config: SchedulerConfig,
    private readonly clock: Clock = systemClock,
  ) {}

  setPreviewActivitySource(read: () => Promise<unknown>, isProbe: (fingerprint: string) => boolean,
    masterStartedAt = Date.now() - process.uptime() * 1000): void {
    this.activitySource = { read, isProbe, masterStartedAt };
    this.activityUnknown = true;
  }

  private activityMonotonicNow(): number { return this.clock.monotonicNow?.() ?? performance.now(); }

  setPreviewActivityTransitionListener(listener: (event: PreviewActivityTransition) => void): void {
    this.activityTransition = listener;
  }

  async readPreviewActivityStatus(): Promise<PreviewActivityStatus | undefined> {
    await this.refreshPreviewActivity();
    return this.getSnapshot().previewActivity;
  }

  private async refreshPreviewActivity(): Promise<boolean> {
    const source = this.activitySource;
    if (!source) return true;
    if (this.activityRefresh) return this.activityRefresh;
    this.activityRefresh = (async () => {
      const previousReason = this.activityReason;
      try {
        const value = await source.read();
        const historicalBoundarySettled = this.activityGraceDeadline !== undefined
          && this.activityMonotonicNow() >= this.activityGraceDeadline;
        const result = resolvePreviewActivity(value, this.clock.now(), source.masterStartedAt, source.isProbe, historicalBoundarySettled);
        for (const observation of result.observations) this.touchAt(observation.branchId, observation.at);
        this.activityUnknown = result.unknown;
        this.activityReason = result.reason;
      } catch { this.activityUnknown = true; this.activityReason = 'read-failed'; }
      const status = this.activityUnknown ? 'unknown' : 'ready';
      this.activityObservedAt = new Date(this.clock.now()).toISOString();
      if (this.activityUnknown && this.activityReason !== 'historical-marker') this.activityLastUnknownAt = this.activityObservedAt;
      const previousStatus = this.activityLastObservedStatus;
      this.activityLastObservedStatus = status;
      if ((status !== previousStatus || this.activityReason !== previousReason) && (previousStatus !== undefined || status === 'unknown')) {
        try { this.activityTransition?.({ status, reason: this.activityReason, observedAt: this.activityObservedAt, lastUnknownAt: this.activityLastUnknownAt }); }
        catch { console.warn('[scheduler] 预览活动状态事件未写入，请检查诊断存储'); }
      }
      if (!this.activityUnknown) return true;
      // 每进程只有一次恢复宽限。重复旧收据、持续读取失败及墙钟回拨都不能续期。
      this.activityGraceDeadline ??= this.activityMonotonicNow() + ACTIVITY_RECOVERY_GRACE_MS;
      if (this.activityMonotonicNow() >= this.activityGraceDeadline && !this.activityUnknownReported) {
        this.activityUnknownReported = true;
        console.warn('[scheduler] 预览访问状态仍不可确认，暂停自动降温和需要腾位的新唤醒');
      }
      return false; // 当前未知永远不是闲置证明；宽限只结算启动前的历史标记。
    })();
    try { return await this.activityRefresh; }
    finally { this.activityRefresh = undefined; }
  }

  setRuntimePresenceProvider(provider: () => ReadonlySet<string> | null): void { this.runtimePresence = provider; }
  setOperationProtection(provider: (slug: string) => boolean): void { this.operationProtection = provider; }
  setResourcePressureProvider(provider: NonNullable<SchedulerService['pressure']>): void { this.pressure = provider; }
  private async refreshResourcePressure(): Promise<void> {
    try { this.observedPressure = await this.pressure?.() ?? 'unknown'; } catch { this.observedPressure = 'unknown'; }
  }
  private maxHot(): number { return Math.min(MAX_HOT_BRANCHES, this.config.maxHotBranches > 0 ? this.config.maxHotBranches : MAX_HOT_BRANCHES); }

  private occupancy(branch: BranchEntry): SchedulerSnapshot['occupancy'][number] {
    const row = (state: SchedulerSnapshot['occupancy'][number]['state'], reason: string) => ({ slug: branch.id, state, reason });
    if (this.reservations.has(branch.id) || this.operationProtection?.(branch.id)) return row('reserved', '在途操作');
    if (this.hasResidentRuntime(branch) || Object.values(branch.services || {}).some(s => s.status === 'running' && (s.staticWeb || s.runtimeKind === 'static'))) return row('resident', '已确认运行资源');
    const hinted = branch.heatState === 'hot' || branch.heatState === 'warming' || (branch.heatState === undefined && branch.status === 'running');
    if (!this.runtimePresence) return row(hinted ? 'resident' : 'nonresident', '兼容未接入运行盘点的实例');
    const services = Object.values(branch.services || {});
    const members = Object.values(branch.replicaSets || {}).flatMap(set => set.members);
    if (!this.readRunningNames()) return row(hinted || services.length > 0 || members.length > 0 ? 'unknown' : 'nonresident', '运行盘点未知，保留既有预约');
    // Absence alone is insufficient: require explicit idle/stop intent as well.
    const idle = branch.status === 'idle' && services.every(s => ['idle', 'stopped'].includes(s.status))
      && members.every(m => ['idle', 'stopped'].includes(m.status));
    if (idle && branch.heatState !== 'warming') return row('nonresident', services.length || members.length ? '已确认停止且无驻留资源' : '空闲登记，无服务或副本预约');
    return row(hinted || services.length > 0 || members.length > 0 ? 'unknown' : 'nonresident', '用途或运行状态待核对，保留预约');
  }

  private hasResidentRuntime(branch: BranchEntry): boolean {
    const names = this.readRunningNames();
    return Boolean(names && (Object.values(branch.services || {}).some(service =>
      serviceRuntimeRefs(service).some(runtime => names.has(runtime.containerName)))
      || Object.values(branch.replicaSets || {}).some(set => set.members.some(member =>
        member.containerName && names.has(member.containerName)))));
  }

  private readRunningNames(): ReadonlySet<string> | null {
    try { return this.runtimePresence?.() ?? null; } catch { return null; }
  }

  setWakeFn(fn: WakeFn): void {
    this.wakeFn = fn;
  }

  setCoolFn(fn: CoolFn): void {
    this.coolFn = fn;
  }

  /** Is the scheduler actively managing branches? */
  isEnabled(): boolean {
    return this.config.enabled === true;
  }

  /**
   * Flip the enabled flag at runtime. Mirrors the UI toggle exposed via
   * `PUT /api/scheduler/enabled`. Idempotent: enabling an already-enabled
   * scheduler or disabling an already-disabled one is a no-op. When flipping
   * from enabled→disabled we stop the tick loop; when flipping from
   * disabled→enabled we start it. The persistent storage side of the
   * override is the caller's responsibility (StateService.setSchedulerEnabledOverride).
   */
  setEnabled(enabled: boolean): void {
    if (this.config.enabled === enabled) return;
    this.config.enabled = enabled;
    if (enabled) {
      this.start();
      console.log('[scheduler] enabled at runtime (via UI toggle)');
    } else {
      this.stop();
      console.log('[scheduler] disabled at runtime (via UI toggle)');
    }
  }

  /**
   * Update the idle timeout at runtime. No start/stop needed: tick() reads
   * `this.config.idleTTLSeconds` fresh on every pass, so a running tick loop
   * picks up the new value automatically. Persistence is the caller's job
   * (StateService.setSchedulerIdleTTLOverride).
   */
  setIdleTTLSeconds(seconds: number): void {
    if (this.config.idleTTLSeconds === seconds) return;
    this.config.idleTTLSeconds = seconds;
    console.log(`[scheduler] idleTTLSeconds set to ${seconds} at runtime (via UI)`);
  }

  /**
   * Update the hot-pool cap at runtime. Capacity-based cooling in tick()
   * reads `this.config.maxHotBranches` fresh, so no restart is required.
   */
  setMaxHotBranches(max: number): void {
    if (this.config.maxHotBranches === max) return;
    this.config.maxHotBranches = max;
    console.log(`[scheduler] maxHotBranches set to ${max} at runtime (via UI)`);
  }

  /**
   * Start the periodic tick. Safe to call multiple times.
   * Does nothing when scheduler is disabled.
   */
  start(): void {
    if (!this.isEnabled()) return;
    if (this.tickHandle) return;
    const intervalMs = Math.max(1000, (this.config.tickIntervalSeconds || 60) * 1000);
    this.tickHandle = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[scheduler] tick error:', (err as Error).message);
      });
    }, intervalMs);
    // Don't keep the event loop alive just for ticking.
    if (typeof this.tickHandle.unref === 'function') {
      this.tickHandle.unref();
    }
    console.log(`[scheduler] started (maxHot=${this.config.maxHotBranches}, idleTTL=${this.config.idleTTLSeconds}s, tick=${this.config.tickIntervalSeconds}s)`);
  }

  /**
   * Stop the periodic tick. Used on process shutdown and in tests.
   */
  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /**
   * Called by the proxy after a successful route to a branch.
   * Updates `lastAccessedAt` (the LRU key) in memory immediately and persists
   * to disk at most once per TOUCH_PERSIST_THROTTLE_MS per branch.
   *
   * Throttling is safe because:
   *   - Eviction reads the in-memory timestamp, which is always fresh
   *   - The persisted value only matters on process restart, and
   *     15s staleness is acceptable for a restart window
   *
   * No-op when scheduler is disabled.
   */
  touch(slug: string): void {
    this.touchAt(slug, this.clock.now());
  }

  private touchAt(slug: string, observedAt: number): void {
    if (!this.isEnabled()) return;
    const branch = this.stateService.getBranch(slug);
    if (!branch) return;
    const now = this.clock.now();
    if (!Number.isFinite(observedAt) || observedAt > now || observedAt < Date.parse(branch.createdAt)
      || observedAt <= (Date.parse(branch.lastAccessedAt ?? '') || 0)) return;
    branch.lastAccessedAt = new Date(observedAt).toISOString();

    const lastPersist = this.lastPersistedTouch.get(slug) || 0;
    if (now - lastPersist >= TOUCH_PERSIST_THROTTLE_MS) {
      this.lastPersistedTouch.set(slug, now);
      this.stateService.save([{ kind: 'branches', id: slug }]);
    }
  }

  /**
   * Mark a branch as HOT in the scheduler's view.
   * Called after a successful wake (deploy/redeploy) completes.
   * Does NOT perform any wake action itself — that is the caller's job.
   */
  markHot(slug: string): void {
    if (!this.isEnabled()) return;
    const branch = this.stateService.getBranch(slug);
    if (!branch) return;
    branch.heatState = 'hot';
    if (!branch.lastAccessedAt) {
      branch.lastAccessedAt = new Date(this.clock.now()).toISOString();
    }
    this.stateService.save();
  }

  /**
   * Cool a branch: invoke the registered coolFn and mark heatState=cold.
   * The coolFn is responsible for stopping containers and updating service statuses.
   * Pinned branches are never cooled — the call is a silent no-op.
   */
  async markCold(slug: string): Promise<void> {
    if (this.coolingTasks.has(slug)) return;
    const task = this.performCold(slug);
    this.coolingTasks.set(slug, task);
    try { await task; } finally { this.coolingTasks.delete(slug); }
  }

  private async performCold(slug: string): Promise<void> {
    if (!this.isEnabled()) return;
    const branch = this.stateService.getBranch(slug);
    if (!branch) return;
    if (this.isPinned(branch)) return;
    if ((branch.heatState === 'cold' && !this.hasResidentRuntime(branch)) || this.cooling.has(slug)) return;
    if (!this.coolFn) throw new Error('降温执行器未接入，保留现有占用');

    this.cooling.add(slug);
    branch.heatState = 'cooling';
    this.stateService.save();

    try {
      if (this.coolFn) {
        await this.coolFn(slug);
      }
      branch.heatState = 'cold';
      this.stateService.save();
      console.log(`[scheduler] cooled branch "${slug}"`);
    } catch (err) {
      console.error(`[scheduler] cool failed for "${slug}":`, (err as Error).message);
      // Revert on failure so we retry next tick.
      branch.heatState = 'hot';
      this.stateService.save();
      throw err;
    } finally {
      this.cooling.delete(slug);
    }
  }

  /**
   * Wake a branch: invoke the registered wakeFn and mark heatState=hot.
   * Enforces capacity: if the hot pool would exceed maxHotBranches, evicts
   * the LRU non-pinned branch first.
   */
  async wake(slug: string): Promise<void> {
    if (this.stateService.getBranch(slug)?.archive) throw new Error('分支已归档，请先恢复后再启动');
    if (!this.isEnabled()) {
      if (this.wakeFn) await this.wakeFn(slug);
      return;
    }
    const branch = this.stateService.getBranch(slug);
    // Note: branch may not yet exist if this is a first-time request. In that
    // case we still call wakeFn (it will create the branch), and mark hot after.
    if (this.waking.has(slug)) return this.waking.get(slug);
    if (branch && branch.heatState === 'hot' && this.occupancy(branch).state === 'resident') {
      // Already hot — just refresh access time.
      this.touch(slug);
      return;
    }

    const operation = this.performWake(slug, branch);
    this.waking.set(slug, operation);
    try { await operation; } finally { this.waking.delete(slug); this.reservations.delete(slug); }
  }

  private async performWake(slug: string, branch: BranchEntry | undefined): Promise<void> {
    // Do not start a runtime while an already dispatched stop is still pending.
    await this.coolingTasks.get(slug);
    const admitted = this.admission.then(async () => {
      await this.evictLruIfOverCapacity(slug);
      this.reservations.add(slug);
    });
    this.admission = admitted.catch(() => {});
    await admitted;

    if (branch) {
      branch.heatState = 'warming';
      this.stateService.save();
    }

    try {
      if (this.wakeFn) {
        await this.wakeFn(slug);
      }
      const fresh = this.stateService.getBranch(slug);
      if (fresh) {
        fresh.heatState = 'hot';
        fresh.lastAccessedAt = new Date(this.clock.now()).toISOString();
        this.stateService.save();
      }
    } catch (err) {
      const fresh = this.stateService.getBranch(slug);
      if (fresh) {
        fresh.heatState = 'cold';
        this.stateService.save();
      }
      throw err;
    }
  }

  /**
   * Mark a branch as pinned-by-user.
   */
  pin(slug: string, pin: BranchPin = createBranchPin({}, {}, 'internal', this.clock.now())): void {
    const branch = this.stateService.getBranch(slug);
    if (!branch) throw new Error(`分支 "${slug}" 不存在`);
    branch.pinnedByUser = true;
    branch.userPin = pin;
    this.stateService.save();
  }

  /**
   * Remove pinned-by-user flag. Note: the branch may still be implicitly
   * pinned via defaultBranch / colorMarked / config.pinnedBranches.
   */
  unpin(slug: string): void {
    const branch = this.stateService.getBranch(slug);
    if (!branch) throw new Error(`分支 "${slug}" 不存在`);
    branch.pinnedByUser = false;
    this.stateService.save();
  }

  reviewConfigPin(slug: string, pin: BranchPin): void {
    const branch = this.stateService.getBranch(slug);
    if (!branch || !this.config.pinnedBranches.includes(slug) || !pin.authorizationRef) throw new Error('仅可复核已登记的配置保护，且必须保留授权依据');
    branch.configPinReview = { ...pin, configuredBranches: [...this.config.pinnedBranches] };
    this.stateService.save();
  }

  /**
   * Is this branch protected from eviction?
   *
   * 判定本身**不在这里**：统一走 `branch-protection.ts` 的 SSOT
   * （pinnedByUser / isColorMarked / per-project defaultBranch /
   *   config.pinnedBranches / 主干分支按 git 分支名判定）。
   *
   * 2026-07-27 P0：janitor 曾各写一份保护判定且漏了主干那条，导致 main 被整条删除。
   * 收敛到同一个函数后，两处漂移在结构上不再可能发生。行为与此前逐条判定完全一致。
   */
  isPinned(branch: BranchEntry): boolean {
    return resolveBranchProtection(branch, this.stateService, this.config.pinnedBranches ?? [], this.clock.now()).protected
      || Boolean(this.operationProtection?.(branch.id));
  }

  /**
   * Find the LRU (least-recently-accessed) non-pinned HOT branch.
   * Returns null if there's nothing to evict.
   */
  selectLruVictim(excludeSlug?: string): BranchEntry | null {
    const hotBranches = this.getHotBranches().filter(b => b.id !== excludeSlug && !this.isPinned(b)
      && this.occupancy(b).state === 'resident' && !this.cooling.has(b.id) && !this.reservations.has(b.id));
    if (hotBranches.length === 0) return null;

    return hotBranches.reduce<BranchEntry | null>((oldest, b) => {
      if (!oldest) return b;
      const oldestTs = oldest.lastAccessedAt ? Date.parse(oldest.lastAccessedAt) : 0;
      const bTs = b.lastAccessedAt ? Date.parse(b.lastAccessedAt) : 0;
      return bTs < oldestTs ? b : oldest;
    }, null);
  }

  /**
   * If the hot pool would exceed maxHotBranches after waking `excludeSlug`,
   * cool the LRU victim. Returns the number of branches cooled (0 or 1).
   *
   * Effective capacity never exceeds 25, including legacy unlimited settings.
   */
  async evictLruIfOverCapacity(excludeSlug?: string): Promise<number> {
    if (!this.isEnabled()) return 0;
    const max = this.maxHot();

    const hotCount = this.hotIds(excludeSlug).size;
    // +1 for the branch we're about to wake (if it's not already hot).
    if (hotCount + 1 <= max) return 0;
    if (!await this.refreshPreviewActivity()) throw new Error('预览访问状态暂不可确认，请稍后重试');

    let cooled = 0;
    while (this.hotIds(excludeSlug).size + 1 > max) {
      const victim = this.selectLruVictim(excludeSlug);
      const before = this.hotIds(excludeSlug).size;
      if (!victim) throw new Error(`热池已满（${before}/${max}），现有保护或用途待确认，暂不新增唤醒`);
      await this.markCold(victim.id);
      if (this.hotIds(excludeSlug).size >= before) throw new Error('降温未确认释放容量，暂不新增唤醒');
      cooled++;
    }
    return cooled;
  }

  /**
   * Background tick: cool branches idle for more than idleTTLSeconds,
   * and ensure capacity is within budget.
   */
  async tick(): Promise<void> {
    if (this.tickInFlight) return this.tickInFlight;
    this.tickInFlight = this.runTick();
    try { await this.tickInFlight; } finally { this.tickInFlight = undefined; }
  }

  private async runTick(): Promise<void> {
    if (!this.isEnabled()) return;
    if (!await this.refreshPreviewActivity()) return;
    await this.refreshResourcePressure();

    const now = this.clock.now();
    const idleTTLMs = (this.config.idleTTLSeconds || 900) * 1000;

    // 1. Idle-based cooling
    const hotBranches = this.getHotBranches();
    for (const branch of this.observedPressure === 'ample' ? [] : hotBranches) {
      if (this.isPinned(branch)) continue;
      if (this.occupancy(branch).state !== 'resident') continue;
      const lastAccess = branch.lastAccessedAt ? Date.parse(branch.lastAccessedAt) : 0;
      if (lastAccess <= 0) continue; // never accessed; don't cool yet
      if (now - lastAccess > idleTTLMs) {
        try {
          await this.markCold(branch.id);
        } catch (err) {
          console.error(`[scheduler] idle cool failed for "${branch.id}":`, (err as Error).message);
        }
      }
    }

    // 2. Capacity-based cooling (in case external deploys bypassed wake())
    const max = this.maxHot();
    if (max > 0) {
      const attempted = new Set<string>();
      while (this.hotIds().size > max) {
        const victim = this.selectLruVictim();
        if (!victim || attempted.has(victim.id)) break;
        attempted.add(victim.id);
        try {
          await this.markCold(victim.id);
        } catch {
          break;
        }
      }
    }
  }

  /**
   * Return the current hot pool as BranchEntry[].
   * A branch is considered "hot" when heatState=hot OR heatState is undefined
   * but the branch is actually running (legacy branches pre-scheduler).
   */
  private getHotBranches(): BranchEntry[] {
    return this.stateService.getAllBranches().filter(b => this.occupancy(b).state !== 'nonresident');
  }

  private hotIds(exclude?: string): Set<string> {
    return new Set([...this.getHotBranches().map(b => b.id), ...this.reservations].filter(id => id !== exclude));
  }

  /**
   * Return a serializable snapshot for the Dashboard / API.
   */
  getSnapshot(): SchedulerSnapshot {
    const all = this.stateService.getAllBranches();
    const hot = this.getHotBranches()
      .map(b => ({
        slug: b.id,
        lastAccessedAt: b.lastAccessedAt,
        pinned: this.isPinned(b),
      }));
    const cold = all
      .filter(b => (b.heatState === 'cold' || b.heatState === 'cooling') && !this.hasResidentRuntime(b))
      .map(b => ({
        slug: b.id,
        lastAccessedAt: b.lastAccessedAt,
      }));

    return {
      enabled: this.isEnabled(),
      config: { ...this.config, maxHotBranches: this.maxHot() },
      hot,
      cold,
      capacityUsage: {
        current: this.hotIds().size,
        max: this.maxHot(),
      },
      resourcePressure: this.observedPressure,
      occupancy: all.map(b => this.occupancy(b)),
      protections: all.flatMap(branch => {
        const rows: SchedulerSnapshot['protections'] = [];
        for (const [source, enabled, pin] of [['user', branch.pinnedByUser, branch.userPin], ['debug', branch.isColorMarked, branch.colorMarkPin]] as const) {
          if (enabled) rows.push({ slug: branch.id, source, active: !pinExpired(pin, this.clock.now()), reviewRequired: pinNeedsReview(pin), pin });
        }
        if (this.config.pinnedBranches.includes(branch.id)) {
          const pin = reviewedConfigPin(branch.configPinReview, this.config.pinnedBranches);
          rows.push({ slug: branch.id, source: 'config-pinned', active: !pinExpired(pin, this.clock.now()), reviewRequired: pinNeedsReview(pin), pin });
        }
        const implicit = resolveBranchProtection({ ...branch, pinnedByUser: false, isColorMarked: false }, this.stateService, [], this.clock.now());
        if (implicit.protected) rows.push({ slug: branch.id, source: implicit.reason!, active: true, reviewRequired: implicit.reason === 'config-pinned' });
        return rows;
      }),
      ...(this.activitySource ? { previewActivity: { status: this.activityUnknown ? 'unknown' as const : 'ready' as const,
        reason: this.activityReason, observedAt: this.activityObservedAt, lastUnknownAt: this.activityLastUnknownAt,
        recoveryGraceRemainingMs: this.activityUnknown && this.activityGraceDeadline !== undefined
          ? Math.max(0, this.activityGraceDeadline - this.activityMonotonicNow()) : 0 } } : {}),
    };
  }
}
