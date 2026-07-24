/**
 * 复制集模式 REST API（design.cds.replica-set，2026-07-23）。
 *
 * 挂载于 /api，全部路径带 branchId（项目归属经分支反查后走 assertProjectAccess）。
 * 控制面语义见 services/replica-set.ts；流量分配在 forwarder 数据面。
 */
import { Router, type Request } from 'express';
import { connect as tcpConnect } from 'node:net';
import type { DeploymentVersion } from '../types.js';
import type { StateService } from '../services/state.js';
import { ReplicaSetError, REPLICA_MEMBER_LIMIT, type ReplicaSetService } from '../services/replica-set.js';
import type { VersionDispatchResult } from './deployment-versions.js';
import type { DeploymentVersionService } from '../services/deployment-version.js';

export interface ReplicaSetsRouterDeps {
  stateService: StateService;
  replicaSetService: ReplicaSetService;
  deploymentVersionService: DeploymentVersionService;
  assertProjectAccess: (req: Request, projectId: string) => { status: number; body: unknown } | null;
  dispatchVersion: (version: DeploymentVersion, trigger: 'manual' | 'rollback') => Promise<VersionDispatchResult>;
}

export function createReplicaSetsRouter(deps: ReplicaSetsRouterDeps): Router {
  const router = Router();

  const guard = (req: Request, branchId: string): { status: number; body: unknown } | null => {
    const branch = deps.stateService.getBranch(branchId);
    if (!branch) return { status: 404, body: { error: `分支不存在: ${branchId}` } };
    return deps.assertProjectAccess(req, branch.projectId);
  };

  /** 逐成员真实可达性探测：TCP 直连宿主端口，700ms 超时。
   * （验收 P1-2：死副本上游 ECONNREFUSED 仍显示绿色「运行中」并持续接流量——
   * 状态字段只反映控制面意图，健康必须实测。） */
  const tcpReachable = (port: number, timeoutMs = 700): Promise<boolean> =>
    new Promise((resolve) => {
      const sock = tcpConnect({ host: '127.0.0.1', port });
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(timeoutMs, () => done(false));
      sock.on('connect', () => done(true));
      sock.on('error', () => done(false));
    });

  router.get('/branches/:branchId/replica-sets', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      const { replicaSets, candidates, snapshots } = deps.replicaSetService.list(req.params.branchId);
      const branch = deps.stateService.getBranch(req.params.branchId)!;
      const enriched = Object.fromEntries(await Promise.all(
        Object.entries(replicaSets).map(async ([profileId, rs]) => {
          const primaryPort = branch.services?.[profileId]?.hostPort;
          const [primaryReachable, members] = await Promise.all([
            primaryPort && branch.services?.[profileId]?.status === 'running'
              ? tcpReachable(primaryPort)
              : Promise.resolve(undefined),
            Promise.all(rs.members.map(async (m) => ({
              ...m,
              reachable: m.status === 'running' && m.hostPort ? await tcpReachable(m.hostPort) : undefined,
            }))),
          ]);
          return [profileId, { ...rs, members, primaryReachable }] as const;
        }),
      ));
      res.json({ replicaSets: enriched, candidates, snapshots, memberLimit: REPLICA_MEMBER_LIMIT });
    } catch (err) {
      respondError(res, err);
    }
  });

  /**
   * 分流探测（强校验性）：CDS 服务端向真实入口（本机 forwarder，带预览 Host）
   * 发 N 个「无粘性」的独立请求，统计响应头 X-CDS-Replica 的真实落点分布。
   * 不是前端动画——每一条都是真实穿过 forwarder 加权选择的 HTTP 请求。
   */
  router.post('/branches/:branchId/replica-sets/:profileId/probe', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const host = typeof req.body?.host === 'string' ? req.body.host.trim().toLowerCase() : '';
    if (!host || !/^[a-z0-9.-]+$/.test(host)) { res.status(400).json({ error: '缺少合法的入口 host' }); return; }
    // 探测 path 必须命中「被复制集化的这个服务」的路由（验收 P1-1：写死 '/'
    // 会打在前端容器上，永远显示 100% 主版本）。未显式传 path 时按 profile
    // 的 pathPrefixes / api-convention 自动推导。
    let path = typeof req.body?.path === 'string' && req.body.path.startsWith('/') ? req.body.path : '';
    if (!path) {
      const branchEntry = deps.stateService.getBranch(req.params.branchId)!;
      const profile = deps.stateService.getEffectiveProfilesForBranch(branchEntry)
        .find((p) => p.id === req.params.profileId);
      path = profile?.pathPrefixes?.[0]
        || (req.params.profileId.includes('api') || req.params.profileId.includes('backend') ? '/api/' : '/');
    }
    const count = Math.max(1, Math.min(50, Number(req.body?.count) || 20));
    const forwarderPort = Number(process.env.CDS_FORWARDER_PORT) || 9090;
    const hits: Array<{ seq: number; servedBy: string; status: number }> = [];
    const tally: Record<string, number> = {};
    // 必须用原生 http.request：fetch(undici) 会静默忽略自定义 Host 头，
    // 请求匹配不到分支路由 → 全落 unknown-host 兜底被误记成 primary
    // （2026-07-23 用户实测「100% 主版本」抓到的真 bug）。
    const { request: httpRequest } = await import('node:http');
    const probeOnce = (seq: number): Promise<{ servedBy: string; status: number }> =>
      new Promise((resolve) => {
        const req2 = httpRequest({
          host: '127.0.0.1',
          port: forwarderPort,
          method: 'GET',
          path: `${path}${path.includes('?') ? '&' : '?'}__probe=${seq}`,
          headers: { Host: host, 'X-CDS-Probe': '1' },
          timeout: 8000,
        }, (resp) => {
          resp.resume();
          // 无 X-CDS-Replica 头 = 没有穿过复制集路由（不能伪装成 primary 落点）
          const tag = resp.headers['x-cds-replica'];
          resolve({ servedBy: tag ? String(tag) : 'untagged', status: resp.statusCode || 0 });
        });
        req2.on('timeout', () => { req2.destroy(); resolve({ servedBy: 'error', status: 0 }); });
        req2.on('error', () => resolve({ servedBy: 'error', status: 0 }));
        req2.end();
      });
    for (let i = 0; i < count; i += 1) {
      const r = await probeOnce(i);
      hits.push({ seq: i + 1, servedBy: r.servedBy, status: r.status });
      tally[r.servedBy] = (tally[r.servedBy] || 0) + 1;
    }
    res.json({ count, host, path, tally, hits });
  });

  // ── 执行计划（草稿-保存模型）：保存即串行执行；执行中可调序/跳过/取消 ──
  router.get('/branches/:branchId/replica-plans', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      res.json({ plans: deps.replicaSetService.listPlans(req.params.branchId) });
    } catch (err) { respondError(res, err); }
  });

  router.post('/branches/:branchId/replica-plans', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      const plan = deps.replicaSetService.startPlan(req.params.branchId, {
        onFailure: req.body?.onFailure === 'rollback' ? 'rollback' : 'stop',
        steps: Array.isArray(req.body?.steps) ? req.body.steps : [],
      });
      res.status(202).json({ plan });
    } catch (err) { respondError(res, err); }
  });

  router.patch('/branches/:branchId/replica-plans/:planId', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      const order = Array.isArray(req.body?.order) ? req.body.order.map(String) : [];
      res.json({ plan: deps.replicaSetService.reorderPlan(req.params.branchId, req.params.planId, order) });
    } catch (err) { respondError(res, err); }
  });

  router.post('/branches/:branchId/replica-plans/:planId/steps/:stepId/skip', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      res.json({ plan: deps.replicaSetService.skipStep(req.params.branchId, req.params.planId, req.params.stepId) });
    } catch (err) { respondError(res, err); }
  });

  router.post('/branches/:branchId/replica-plans/:planId/cancel', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      res.json({ plan: deps.replicaSetService.cancelPlan(req.params.branchId, req.params.planId) });
    } catch (err) { respondError(res, err); }
  });

  // profile 级复制隔离：复制一次 → 全体副本切隔离库；回切主库快照保留
  router.post('/branches/:branchId/replica-sets/:profileId/isolate', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const result = deps.replicaSetService.isolateProfile(req.params.branchId, req.params.profileId);
    if (!result.accepted) { res.status(409).json({ error: result.reason }); return; }
    res.status(202).json({ accepted: true });
  });

  router.post('/branches/:branchId/replica-sets/:profileId/revert-db', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const result = deps.replicaSetService.revertProfile(req.params.branchId, req.params.profileId);
    if (!result.accepted) { res.status(409).json({ error: result.reason }); return; }
    res.status(202).json({ accepted: true });
  });

  // 隔离库快照删除（保留语义的唯一出口：显式删除才 drop 数据库）
  router.delete('/branches/:branchId/replica-db-snapshots/:snapshotId', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      const snapshot = await deps.replicaSetService.deleteDbSnapshot(req.params.branchId, req.params.snapshotId);
      res.json({ dropped: true, dbName: snapshot.dbName });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.post('/branches/:branchId/replica-sets/:profileId', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      const rs = deps.replicaSetService.enable(req.params.branchId, req.params.profileId);
      res.status(201).json({ replicaSet: rs });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.delete('/branches/:branchId/replica-sets/:profileId', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      await deps.replicaSetService.dissolve(req.params.branchId, req.params.profileId);
      res.json({ dissolved: true });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.post('/branches/:branchId/replica-sets/:profileId/members', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const versionId = typeof req.body?.versionId === 'string' ? req.body.versionId.trim() : '';
    try {
      const member = deps.replicaSetService.addMember(req.params.branchId, req.params.profileId, {
        versionId: versionId || undefined,
        label: typeof req.body?.label === 'string' ? req.body.label : undefined,
        weight: typeof req.body?.weight === 'number' ? req.body.weight : undefined,
        dbMode: req.body?.dbMode === 'isolated' ? 'isolated' : 'shared',
      });
      res.status(202).json({ member });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.patch('/branches/:branchId/replica-sets/:profileId/members/:memberId', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      const rs = deps.replicaSetService.updateMember(
        req.params.branchId,
        req.params.profileId,
        req.params.memberId,
        {
          weight: typeof req.body?.weight === 'number' ? req.body.weight : undefined,
          label: typeof req.body?.label === 'string' ? req.body.label : undefined,
          primaryWeight: typeof req.body?.primaryWeight === 'number' ? req.body.primaryWeight : undefined,
        },
      );
      res.json({ replicaSet: rs });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.delete('/branches/:branchId/replica-sets/:profileId/members/:memberId', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      await deps.replicaSetService.removeMember(
        req.params.branchId,
        req.params.profileId,
        req.params.memberId,
      );
      res.json({ removed: true });
    } catch (err) {
      respondError(res, err);
    }
  });

  /**
   * 提升成员为主版本：走既有 deploy {versionId} 回滚机制重建主容器，
   * 成功派发后解散复制集（成员使命完成，退回普通模式）。
   */
  router.post('/branches/:branchId/replica-sets/:profileId/members/:memberId/promote', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const branch = deps.stateService.getBranch(req.params.branchId)!;
    const rs = branch.replicaSets?.[req.params.profileId];
    const member = rs?.members.find((m) => m.id === req.params.memberId);
    if (!rs || !member) { res.status(404).json({ error: '成员不存在' }); return; }
    const version = deps.deploymentVersionService.get(member.versionId);
    if (!version) { res.status(404).json({ error: `部署版本不存在: ${member.versionId}` }); return; }
    try {
      deps.deploymentVersionService.assertReusable(version);
    } catch (err) {
      res.status(409).json({ error: 'deployment_version_not_reusable', message: (err as Error).message });
      return;
    }
    const result = await deps.dispatchVersion(version, 'rollback');
    if (!result.accepted) {
      res.status(result.status || 500).json({ error: result.error || '版本部署未被接受' });
      return;
    }
    await deps.replicaSetService.dissolve(req.params.branchId, req.params.profileId);
    res.status(202).json({
      accepted: true,
      promotedVersionId: version.id,
      runId: result.runId,
      streamUrl: result.runId ? `/api/deployment-runs/${result.runId}/stream` : undefined,
    });
  });

  // ── 数据库保护罩（用户拍板：数据库芯片上的锁按钮，一键克隆隔离库 + 可查询进度） ──
  // 内存态运行表：branchId:infraId → 阶段。CDS 重启丢进度可接受（克隆本身幂等重跑）。
  const guardRuns = new Map<string, {
    stage: 'cloning' | 'done' | 'error';
    detail: string;
    dbName?: string;
    startedAt: string;
  }>();

  router.post('/branches/:branchId/db-guard', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const infraId = typeof req.body?.infraId === 'string' ? req.body.infraId.trim() : '';
    if (!infraId) { res.status(400).json({ error: '缺少 infraId' }); return; }
    const branch = deps.stateService.getBranch(req.params.branchId)!;
    const key = `${branch.id}:${infraId}`;
    if (guardRuns.get(key)?.stage === 'cloning') {
      res.status(409).json({ error: '该数据库正在克隆中' });
      return;
    }
    const result = deps.replicaSetService.startDbGuard(branch.id, infraId, (stage, detail, dbName) => {
      guardRuns.set(key, { stage, detail, dbName, startedAt: guardRuns.get(key)?.startedAt || new Date().toISOString() });
    });
    if (!result.accepted) { res.status(409).json({ error: result.reason }); return; }
    guardRuns.set(key, { stage: 'cloning', detail: '正在克隆…', startedAt: new Date().toISOString() });
    res.status(202).json({ accepted: true, infraId });
  });

  router.get('/branches/:branchId/db-guard/:infraId', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const run = guardRuns.get(`${req.params.branchId}:${req.params.infraId}`);
    res.json({ run: run || null });
  });

  return router;
}

function respondError(res: { status: (code: number) => { json: (body: unknown) => void } }, err: unknown): void {
  if (err instanceof ReplicaSetError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: (err as Error).message });
}
