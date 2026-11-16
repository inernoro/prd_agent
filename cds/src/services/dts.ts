import { randomUUID } from 'node:crypto';
import type { StateService } from './state.js';
import type { ServerEventLogSink } from './server-event-log-store.js';
import { createExternalResponseAudit } from './standby-response-audit.js';
import { dtsConnectionEnvironment, dtsManagedServices, dtsProjectEnvironment } from './dts-connections.js';
import { DtsStore } from './dts-store.js';
import { DtsSeaTunnel, parseDtsEngine } from './dts-seatunnel.js';
import { DtsError, buildDtsMongoJob, dtsConnectionUri, dtsHash, dtsReject, parseDtsConnection, prepareDtsPlan, verifyDtsPlan, withDtsMongo } from './dts-policy.js';
import { DTS_KINDS, DTS_PROTOCOL_VERSION, DTS_TOOLS, SEATUNNEL_VERSION, type DtsActor, type DtsConnection, type DtsEngineBinding, type DtsMode, type DtsPlan, type DtsPolicy, type DtsRun } from '../shared/dts.js';

const WRITER_LOCK = 'dts-native-writer-v1';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
type EngineRow = DtsEngineBinding & { id: string };
export class DtsService {
  private readonly engine: DtsSeaTunnel;
  private readonly inFlight = new Map<string, Promise<DtsRun>>();
  private schedulerBusy = false;
  constructor(readonly store: DtsStore, private readonly state: StateService, private readonly sink: ServerEventLogSink | null | undefined,
    private readonly actorAllowed: (actor: DtsActor, projectId: string) => Promise<boolean>, engine?: DtsSeaTunnel) {
    this.engine = engine ?? new DtsSeaTunnel(state, sink);
  }
  async capabilities(projectId: string) {
    const binding = this.store.configured() ? await this.store.get<EngineRow>('engines', projectId, `engine:${projectId}`) : undefined;
    return { protocolVersion: DTS_PROTOCOL_VERSION, projectId, engineVersion: SEATUNNEL_VERSION, configured: Boolean(binding),
      storeConfigured: this.store.configured(), tools: DTS_TOOLS,
      connectors: DTS_KINDS.map(kind => ({ kind, transport: 'seatunnel', verified: kind === 'mongo',
        modes: kind === 'mongo' ? ['append-only', 'account-authority'] : [],
        message: kind === 'mongo' ? '文本主键、已登记字段的受控同步' : '待完成无损与恢复验证，尚未开放写入' })),
      maxRecords: 10_000, concurrentNativeWriters: 1 };
  }
  async configureEngine(projectId: string, input: unknown) {
    const binding = parseDtsEngine(projectId, input);
    if ((await this.store.activeRuns<DtsRun>(projectId)).length > 0) dtsReject('engine_busy', '存在未结束的同步任务，请先完成或取消后再更换传输服务', 409);
    const info = await this.engine.call(binding, 'overview');
    if (info.projectVersion !== SEATUNNEL_VERSION) dtsReject('engine_version_mismatch', '传输服务实际版本与已验证版本不一致，请先核对安装版本', 409);
    await this.store.put('engines', { ...binding, id: `engine:${projectId}` });
    return { configured: true, version: binding.version };
  }
  private env(c: DtsConnection) { return dtsConnectionEnvironment(this.state, c); }
  services(projectId: string) { return dtsManagedServices(this.state, projectId); }
  private async databaseCall<T>(projectId: string, action: string, fn: () => Promise<T>, summary: (value: T) => unknown, businessRequestId?: string): Promise<T> {
    const audit = createExternalResponseAudit(this.sink, { projectId, remoteProjectId: projectId, policy: 'dts-database', dryRun: action !== 'verify', businessRequestId },
      { source: 'dts', action: 'dts.database.response', message: '数据同步预检响应' });
    audit.assertAvailable(); const start = Date.now(); let result: T | undefined, failure: unknown;
    try { result = await fn(); return result; }
    catch (e) { failure = e; if (e instanceof DtsError) throw e; return dtsReject('database_unavailable', '无法完成数据库预检，请核对连接、权限或服务状态后重试', 503); }
    finally {
      const raw = failure ? { code: (failure as { code?: unknown }).code, message: (failure as Error).message } : summary(result!);
      await audit.record({ peerId: action, url: 'http://dts-database.local/' + action, method: 'READ', startedAt: new Date(start).toISOString(),
        durationMs: Date.now() - start, timeoutMs: 10_000, responseReceived: !failure || failure instanceof DtsError,
        httpStatus: null, upstreamRequestId: null, contentType: 'application/bson', json: raw, text: JSON.stringify(raw), parseState: 'json',
        localDecision: failure ? 'rejected' : 'success', secrets: Object.values(dtsProjectEnvironment(this.state, projectId)).filter(v => v.length > 3) });
    }
  }
  connections(projectId: string) { return this.store.list<DtsConnection>('connections', projectId); }
  async addConnection(projectId: string, input: unknown) {
    const c = parseDtsConnection(projectId, input);
    if (c.infraId) this.env(c);
    if (c.kind === 'mongo') await this.databaseCall(projectId, 'connection', () => withDtsMongo(dtsConnectionUri(c, this.env(c)), async client => {
      await client.db(c.database).command({ ping: 1 }); return true;
    }), () => ({ success: true }), c.id);
    await this.store.put('connections', c); return c;
  }
  private async connection(projectId: string, id: string) {
    const c = await this.store.get<DtsConnection>('connections', projectId, id);
    if (!c) dtsReject('connection_not_found', '所选连接不属于当前项目或已移除，请重新选择', 404); return c;
  }
  async plan(projectId: string, sourceId: string, targetId: string, mode: DtsMode, actor: DtsActor, profileOnly = false) {
    if (!await this.actorAllowed(actor, projectId)) dtsReject('actor_revoked', '当前身份已无权执行同步，请重新核对项目授权', 403);
    const source = await this.connection(projectId, sourceId), target = await this.connection(projectId, targetId);
    const planId = randomUUID();
    const p = await this.databaseCall(projectId, 'plan', () => prepareDtsPlan({ projectId, source, target,
      sourceUri: dtsConnectionUri(source, this.env(source)), targetUri: dtsConnectionUri(target, this.env(target)), mode, actor, profileOnly, planId }),
    p => ({ success: true, sourceCount: p.sourceCount, targetCount: p.targetCount, insertCount: p.insertCount, updateCount: p.updateCount, skipCount: p.skipCount }), planId);
    await this.store.put('plans', p); return this.publicPlan(p);
  }
  publicPlan(p: DtsPlan) { const { keys: _, approvedBy: _actor, ...publicValue } = p; return publicValue; }
  publicRun(r: DtsRun) { const { actor: _, engine: _engine, plan, ...value } = r; return { ...value, plan: this.publicPlan(plan) }; }
  publicPolicy(p: DtsPolicy) { const { actor: _, ...value } = p; return value; }
  async runs(projectId: string) { return this.store.list<DtsRun>('runs', projectId); }
  async run(projectId: string, id: string): Promise<DtsRun> {
    const r = await this.store.get<DtsRun>('runs', projectId, id);
    if (!r) dtsReject('run_not_found', '同步任务不存在或不属于当前项目', 404); return r;
  }
  private async save(r: DtsRun) { r.updatedAt = new Date().toISOString(); await this.store.put('runs', r); return r; }
  async start(projectId: string, planId: string, idempotencyKey: string, actor: DtsActor, schedulerId?: string) {
    if (!idempotencyKey || idempotencyKey.length > 120) dtsReject('idempotency_required', '请使用稳定的操作编号发起同步');
    const previous = await this.store.byIdempotency<DtsRun>(projectId, idempotencyKey);
    if (previous) {
      if (previous.plan.id !== planId) dtsReject('idempotency_conflict', '该操作编号已用于另一份同步计划，请核对原任务', 409);
      return previous;
    }
    const plan = await this.store.get<DtsPlan>('plans', projectId, planId);
    if (!plan || Date.parse(plan.expiresAt) <= Date.now()) dtsReject('plan_expired', '比较结果不存在或已过期，请重新比较后同步', 409);
    const engine = await this.store.get<EngineRow>('engines', projectId, `engine:${projectId}`);
    if (!engine) dtsReject('engine_unavailable', '项目尚未连接传输服务，请联系管理员', 503);
    if (!await this.actorAllowed(actor, projectId)) dtsReject('actor_revoked', '当前同步授权已失效，请核对项目授权', 403);
    const id = randomUUID();
    if (!await this.store.acquire(WRITER_LOCK, projectId, id)) dtsReject('target_busy', '已有同步写入尚未结束或尚未确认停止，请稍后重试', 409);
    const now = new Date().toISOString();
    const r: DtsRun = { id, projectId, plan, status: 'preparing', engine, engineJobId: String(Date.now() * 32 + Math.floor(Math.random() * 32)),
      createdAt: now, updatedAt: now, message: '正在复核数据差异与版本', appliedCount: 0, attempts: 1, idempotencyKey, actor, schedulerId };
    try { await this.save(r); }
    catch (e) { await this.store.release(WRITER_LOCK, id); throw e; }
    // Start is asynchronous and resumable by the persisted, caller-assigned engine job id.
    const work = this.dispatch(r).finally(() => this.inFlight.delete(id)); this.inFlight.set(id, work);
    void work.catch(() => undefined); return r;
  }
  private async dispatch(r: DtsRun): Promise<DtsRun> {
    let mayHaveSubmitted = false;
    try {
      const source = await this.connection(r.projectId, r.plan.sourceId), target = await this.connection(r.projectId, r.plan.targetId);
      const sourceUri = dtsConnectionUri(source, this.env(source)), targetUri = dtsConnectionUri(target, this.env(target));
      const fresh = await this.databaseCall(r.projectId, 'recheck', () => prepareDtsPlan({ projectId: r.projectId, source, target, sourceUri, targetUri, mode: r.plan.mode, actor: r.actor, profileOnly: r.plan.profileOnly }),
        p => ({ sourceCount: p.sourceCount, insertCount: p.insertCount, updateCount: p.updateCount }), r.id);
      if (fresh.sourceFingerprint !== r.plan.sourceFingerprint || fresh.targetFingerprint !== r.plan.targetFingerprint
        || fresh.selectedDigest !== r.plan.selectedDigest || dtsHash(fresh.keys) !== dtsHash(r.plan.keys)) {
        dtsReject('plan_changed', '数据差异、连接或结构已变化，请重新比较后同步', 409);
      }
      if (!await this.actorAllowed(r.actor, r.projectId)) dtsReject('actor_revoked', '同步授权已失效，尚未开始写入', 403);
      if (!r.plan.keys.length) {
        r.status = 'completed'; r.message = '数据已符合当前策略，没有需要写入的记录'; r.finishedAt = new Date().toISOString();
        await this.save(r); await this.store.release(WRITER_LOCK, r.id); return r;
      }
      const config = buildDtsMongoJob(r.plan, source, target, sourceUri, targetUri);
      r.configDigest = dtsHash(config); r.status = 'submitting'; r.message = '正在提交原生数据传输任务'; await this.save(r);
      mayHaveSubmitted = true;
      await this.engine.call(r.engine, 'submit', r.engineJobId, config, r.id);
      r.status = 'running'; r.message = '数据传输中，完成后将独立核对目标数据'; return this.save(r);
    } catch (e) {
      r.status = mayHaveSubmitted ? 'uncertain' : 'failed';
      r.message = mayHaveSubmitted ? '提交结果尚未确认，请刷新原任务状态，不要重复发起' : e instanceof DtsError ? e.message : '同步准备失败，请核对服务状态后重新比较';
      await this.save(r); if (!mayHaveSubmitted) await this.store.release(WRITER_LOCK, r.id); return r;
    }
  }
  async refresh(projectId: string, id: string): Promise<DtsRun> {
    if (this.inFlight.has(id)) return this.run(projectId, id);
    const work = this.refreshOne(projectId, id).finally(() => this.inFlight.delete(id)); this.inFlight.set(id, work); return work;
  }
  private async refreshOne(projectId: string, id: string) {
    const r = await this.run(projectId, id);
    if (TERMINAL.has(r.status) || r.status === 'paused') return r;
    try {
      if (!await this.actorAllowed(r.actor, projectId) && r.status !== 'cancelling') {
        r.stopRequested = 'cancel'; r.status = 'cancelling'; r.message = '授权已失效，正在请求停止数据传输'; await this.save(r);
        await this.engine.call(r.engine, 'stop', r.engineJobId, undefined, r.id);
      }
      const result = await this.engine.call(r.engine, 'status', r.engineJobId, undefined, r.id);
      if (r.stopRequested && !['FINISHED', 'FAILED', 'CANCELED', 'CANCELLED'].includes(String(result.jobStatus))) {
        await this.engine.call(r.engine, 'stop', r.engineJobId, undefined, r.id);
        r.status = r.stopRequested === 'pause' ? 'pausing' : 'cancelling';
      }
      const status = String(result.jobStatus);
      if (status === 'FINISHED') {
        if (r.stopRequested) {
          r.status = r.stopRequested === 'pause' ? 'paused' : 'cancelled'; r.message = '传输已结束；已发生的写入保留，续传前会重新比较';
        } else {
          r.status = 'verifying'; r.message = '传输已结束，正在核对源数据与目标结果'; await this.save(r);
          const source = await this.connection(projectId, r.plan.sourceId), target = await this.connection(projectId, r.plan.targetId);
          const srcUri = dtsConnectionUri(source, this.env(source)), dstUri = dtsConnectionUri(target, this.env(target));
          r.appliedCount = await this.databaseCall(projectId, 'verify', () => verifyDtsPlan(r.plan, source, target, srcUri, dstUri), count => ({ success: true, appliedCount: count }), r.id);
          r.status = 'completed'; r.message = '同步与目标数据核对均已完成';
        }
      } else if (status === 'CANCELED' || status === 'CANCELLED') {
        r.status = r.stopRequested === 'pause' ? 'paused' : 'cancelled'; r.message = '传输已确认停止；后续操作会先重新比较';
      } else if (status === 'FAILED') {
        r.status = 'failed'; r.message = '原生传输任务失败，部分记录可能已写入；请重新比较，续传将跳过已存在记录';
      } else {
        if (!['pausing', 'cancelling'].includes(r.status)) r.status = 'running';
        r.message = r.status === 'running' ? '数据传输中，正在等待原生任务与目标核对结果' : '正在等待传输服务确认停止';
      }
      if (TERMINAL.has(r.status) || r.status === 'paused') {
        r.finishedAt = new Date().toISOString(); await this.save(r); await this.store.release(WRITER_LOCK, r.id); return r;
      }
      return this.save(r);
    } catch (e) {
      if (r.status === 'verifying' && e instanceof DtsError && e.code === 'verification_mismatch') {
        r.status = 'failed'; r.message = e.message; r.finishedAt = new Date().toISOString(); await this.save(r); await this.store.release(WRITER_LOCK, r.id); return r;
      }
      r.status = 'uncertain'; r.message = '暂时无法确认传输或对账结果，已保留写入保护，请稍后刷新原任务'; return this.save(r);
    }
  }
  async control(projectId: string, id: string, action: 'pause' | 'resume' | 'cancel', actor: DtsActor) {
    const r = await this.run(projectId, id);
    if (action === 'resume') {
      if (!['paused', 'failed', 'cancelled'].includes(r.status)) dtsReject('run_not_stopped', '任务尚未确认停止，请先刷新原任务', 409);
      const fresh = await this.plan(projectId, r.plan.sourceId, r.plan.targetId, r.plan.mode, actor, r.plan.profileOnly);
      return this.start(projectId, fresh.id, `resume:${id}:${fresh.id}`, actor, r.schedulerId);
    }
    if (TERMINAL.has(r.status) || r.status === 'paused') return r;
    if (r.status === 'preparing' || this.inFlight.has(id)) dtsReject('run_preparing', '任务正在准备，请稍后刷新状态再操作', 409);
    r.stopRequested = action; r.status = action === 'pause' ? 'pausing' : 'cancelling'; r.message = '正在请求原生传输服务停止'; await this.save(r);
    try { await this.engine.call(r.engine, 'stop', r.engineJobId, undefined, r.id); }
    catch { r.status = 'uncertain'; r.message = '停止结果尚未确认，写入保护仍保留，请稍后刷新'; await this.save(r); }
    return r;
  }
  policies(projectId: string) { return this.store.list<DtsPolicy>('policies', projectId); }
  async setPolicy(projectId: string, id: string, enabled: boolean, actor: DtsActor) {
    const p = await this.store.get<DtsPolicy>('policies', projectId, id);
    if (!p) dtsReject('policy_not_found', '账号同步规则不存在或不属于当前项目', 404);
    if (!await this.actorAllowed(actor, projectId)) dtsReject('actor_revoked', '当前同步授权已失效', 403);
    p.enabled = enabled; p.actor = actor; p.nextDiscoveryAt = new Date().toISOString();
    await this.store.put('policies', p); return p;
  }
  async addPolicy(projectId: string, input: Pick<DtsPolicy, 'sourceId' | 'targetId'>, actor: DtsActor) {
    const target = await this.connection(projectId, input.targetId);
    if (!target.accountFields.length) dtsReject('account_fields_required', '请先由管理员登记允许校准的账号资料字段');
    await this.plan(projectId, input.sourceId, input.targetId, 'account-authority', actor);
    const existing = (await this.policies(projectId)).find(p => p.sourceId === input.sourceId && p.targetId === input.targetId);
    if (existing) return existing;
    const p: DtsPolicy = { id: randomUUID(), projectId, sourceId: input.sourceId, targetId: input.targetId, enabled: true,
      newAccountsEverySeconds: 5, reconcileHour: 3, timezone: 'Asia/Shanghai', nextDiscoveryAt: new Date().toISOString(), actor };
    await this.store.put('policies', p); return p;
  }
  async tick(projectIds: string[]) {
    if (this.schedulerBusy || !this.store.configured()) return;
    this.schedulerBusy = true;
    try {
      for (const projectId of projectIds) {
        for (const r of await this.store.activeRuns<DtsRun>(projectId)) await this.refresh(projectId, r.id);
        for (const p of await this.policies(projectId)) {
          if (!p.enabled || Date.parse(p.nextDiscoveryAt) > Date.now()) continue;
          if (!await this.actorAllowed(p.actor, projectId)) { p.enabled = false; await this.store.put('policies', p); continue; }
          const local = new Intl.DateTimeFormat('sv-SE', { timeZone: p.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).format(new Date());
          const [date, hour] = local.split(' ');
          if (p.lastRunId) {
            const last = await this.run(projectId, p.lastRunId);
            const lastDate = new Intl.DateTimeFormat('sv-SE', { timeZone: p.timezone }).format(new Date(last.createdAt));
            if (last.status === 'completed' && last.plan.mode === 'account-authority' && lastDate === date) p.lastReconcileDate = date;
          }
          const daily = Number(hour) >= p.reconcileHour && p.lastReconcileDate !== date;
          if ((await this.store.activeRuns<DtsRun>(projectId)).length > 0) continue;
          try {
            const plan = await this.plan(projectId, p.sourceId, p.targetId, daily ? 'account-authority' : 'append-only', p.actor, true);
            if (plan.insertCount || (daily && plan.updateCount)) {
              const run = await this.start(projectId, plan.id, `policy:${p.id}:${plan.id}`, p.actor, p.id); p.lastRunId = run.id;
            }
            // A daily claim is not success; it is committed only after that run's independent verification.
            if (daily && p.lastRunId) {
              const run = await this.run(projectId, p.lastRunId);
              if (run.status === 'completed' && run.plan.mode === 'account-authority') p.lastReconcileDate = date;
            } else if (daily && !plan.sourceCount) p.lastReconcileDate = date;
          p.lastError = undefined;
          } catch (e) { p.lastError = e instanceof DtsError ? e.message : '同步检查暂时失败，将在下次检查时重试'; }
          p.nextDiscoveryAt = new Date(Date.now() + p.newAccountsEverySeconds * 1000).toISOString(); await this.store.put('policies', p);
        }
      }
    } finally { this.schedulerBusy = false; }
  }
}
