import crypto from 'node:crypto';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import type { StateService } from '../services/state.js';
import type { CdsConfig, ReleaseStrategy, ReleaseTarget, RemoteHost } from '../types.js';
import { ReleaseService, isReleaseRunTerminal } from '../services/release-service.js';
import { readReleaseHealthSnapshot } from '../services/release-health-snapshot.js';
import {
  discoverReleaseStrategies,
  releaseProjectIdentity,
  validateReleaseStrategy,
} from '../services/release-strategy.js';
import { releaseEvents, type ReleaseEventEnvelope } from '../services/release-events.js';
import { resolveActorFromRequest } from '../services/actor-resolver.js';
import {
  ReleaseTargetHistoryStore,
  recordReleaseTargetUpsert,
} from '../services/release-target-history.js';
import { ReleaseCommitClock } from '../services/release-commit-clock.js';
import { computeReleaseDora, clampDoraWindowDays, DEFAULT_DORA_WINDOW_DAYS } from '../services/release-dora.js';
import { isSuccessfulReleaseRun, KEEP_SUCCESSFUL_RELEASE_RUNS } from '../services/release-retention.js';
import { buildReleaseLogSnapshot } from '../services/release-log-buffer.js';
import { assertProjectAccess } from './projects.js';

export interface ReleasesRouterDeps {
  stateService: StateService;
  /**
   * repoRoot 只用来定位两个旁路台账文件（变更历史 / commit 时间），故意做成可选：
   * 既有单测只传 worktreeBase，加成必填会把它们全部编译红，而这两个台账缺了
   * 也只是「历史空着」，不影响发布本身。
   */
  config?: Pick<CdsConfig, 'worktreeBase'> & Partial<Pick<CdsConfig, 'repoRoot'>>;
}

export function createReleasesRouter(deps: ReleasesRouterDeps): Router {
  const router = Router();
  const service = new ReleaseService(deps.stateService);
  // 没有 repoRoot（单测 / 嵌入式用法）就只在内存里跑，绝不回落到 process.cwd()：
  // 那是别人的目录，往里写审计流水会让每次跑测试都在开发者仓库里留一份垃圾。
  // 生产走 server.ts 传进来的完整 CdsConfig，repoRoot 必然有值。
  const stateRoot = deps.config?.repoRoot;
  const history = new ReleaseTargetHistoryStore({
    storePath: stateRoot ? path.join(stateRoot, '.cds', 'release-target-history.json') : undefined,
    logger: { warn: (m) => console.warn(m) },
  });
  const commitClock = new ReleaseCommitClock({
    storePath: stateRoot ? path.join(stateRoot, '.cds', 'release-commit-times.json') : undefined,
    logger: { warn: (m) => console.warn(m) },
  });

  /**
   * 发布发起后把本次 commit 的提交时间记下来（DORA 变更前置时间的唯一来源）。
   * 尽力而为：worktree 已回收 / git 不可用一律静默跳过，绝不能让一条统计口径
   * 的旁路动作把「发布已经启动」这个既成事实变成 500。
   */
  const rememberCommitTime = (run: { projectId: string; commitSha: string; branchId: string }): void => {
    try {
      const branch = deps.stateService.getBranch(run.branchId);
      commitClock.remember(run.projectId, run.commitSha, branch?.worktreePath);
    } catch { /* 统计旁路，不影响发布 */ }
  };

  router.post('/releases/projects/:projectId/discover', (req, res) => {
    const projectId = req.params.projectId;
    if (rejectProjectMismatch(req, res, projectId)) return;
    const project = deps.stateService.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: `project not found: ${projectId}` });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const requestedBranchId = typeof body.branchId === 'string' ? body.branchId.trim() : '';
    const branches = deps.stateService.getBranchesForProject(projectId);
    const branch = requestedBranchId
      ? branches.find((candidate) => candidate.id === requestedBranchId)
      : branches.find((candidate) => candidate.branch === project.gitDefaultBranch && candidate.status === 'running')
        || branches.find((candidate) => candidate.status === 'running')
        || branches[0];
    if (!branch) {
      res.status(409).json({ error: '项目还没有可检测的分支，请先完成一次分支部署' });
      return;
    }
    res.json(discoverReleaseStrategies(project, branch));
  });

  router.get('/releases/targets', (req, res) => {
    const projectId = resolveReadableProjectId(req, res);
    if (projectId === false) return;
    if (projectId) service.ensureDefaultPlans(projectId);
    const provisionedTargets = deps.stateService.getReleaseTargets(projectId, { includeArchived: true });
    const targets = provisionedTargets.filter((target) => target.lifecycle !== 'archived');
    const archivedTargets = provisionedTargets.filter((target) => target.lifecycle === 'archived');
    // RemoteHost 无 projectId 归属（系统级资源）。项目级调用方只能看到本项目发布目标
    // 实际引用（ssh.privateKeyRef）的主机——与 rejectPrivateKeyRefMismatch 同款归属口径，
    // 避免泄露其他项目的 SSH 主机。无项目语境（系统级调用）时才返回全部。
    const referencedHostIds = projectId
      ? new Set(provisionedTargets.map((t) => t.ssh?.privateKeyRef).filter((ref): ref is string => !!ref))
      : null;
    res.json({
      targets,
      archivedTargets,
      plans: deps.stateService.getReleasePlans(projectId),
      remoteHosts: deps.stateService.getRemoteHosts()
        .filter((host) => referencedHostIds === null || referencedHostIds.has(host.id))
        .map((host) => ({
        id: host.id,
        name: host.name,
        host: host.host,
        sshPort: host.sshPort,
        sshUser: host.sshUser,
        fingerprint: host.sshPrivateKeyFingerprint,
        isEnabled: host.isEnabled,
      })),
    });
  });

  router.post('/releases/targets', (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const access = rejectProjectMismatch(req, res, typeof body.projectId === 'string' ? body.projectId : undefined);
    if (access) return;
    if (rejectUnscopedAiMutation(req, res)) return;
    const strategy = parseReleaseStrategy(body);
    const strategyValidation = validateReleaseStrategy(strategy);
    if (strategyValidation) {
      res.status(400).json({ error: strategyValidation });
      return;
    }
    const validation = validateSshTargetBody(body, false);
    if (validation) {
      res.status(400).json({ error: validation });
      return;
    }
    if (rejectPrivateKeyRefMismatch(
      req,
      res,
      deps.stateService,
      String(body.projectId).trim(),
      String(body.privateKeyRef).trim(),
    )) return;
    const project = deps.stateService.getProject(String(body.projectId).trim());
    if (!project) {
      res.status(404).json({ error: `project not found: ${String(body.projectId).trim()}` });
      return;
    }
    const now = new Date().toISOString();
    const target: ReleaseTarget = {
      id: typeof body.id === 'string' && body.id.trim() ? body.id.trim() : `rt_${crypto.randomBytes(6).toString('hex')}`,
      projectId: String(body.projectId).trim(),
      name: String(body.name).trim(),
      type: 'ssh',
      createdAt: now,
      updatedAt: now,
      createdBy: resolveActorFromRequest(req),
      isEnabled: body.isEnabled !== false,
      lifecycle: 'active',
      environment: normalizeEnvironment(body.environment),
      isCanonical: body.isCanonical !== false,
      projectIdentity: releaseProjectIdentity(project),
      strategy,
      ssh: {
        host: String(body.host).trim(),
        port: Number(body.port || 22),
        user: String(body.user).trim(),
        privateKeyRef: String(body.privateKeyRef).trim(),
        appPath: String(body.appPath).trim(),
        deployCommand: strategy.mode === 'existing-script' ? strategy.command!.trim() : '',
        rollbackCommand: strategy.mode === 'existing-script' && typeof body.rollbackCommand === 'string'
          ? body.rollbackCommand.trim()
          : '',
        healthcheckUrl: String(body.healthcheckUrl).trim(),
      },
    };
    try {
      service.ensureDefaultPlans(target.projectId);
      res.status(201).json({
        target: recordReleaseTargetUpsert(
          { state: deps.stateService, history },
          target,
          { actor: resolveActorFromRequest(req) },
        ),
      });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.post('/releases/targets/local-prod', (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
    if (rejectProjectMismatch(req, res, projectId || undefined)) return;
    if (rejectUnscopedAiMutation(req, res)) return;
    const validation = validateLocalProdTargetBody(body);
    if (validation) {
      res.status(400).json({ error: validation });
      return;
    }
    const project = deps.stateService.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: `project not found: ${projectId}` });
      return;
    }
    const remoteHost = resolveLocalProdRemoteHost(deps.stateService, body);
    if ('error' in remoteHost) {
      res.status(400).json({ error: remoteHost.error });
      return;
    }
    if (rejectPrivateKeyRefMismatch(req, res, deps.stateService, project.id, remoteHost.host.id)) return;

    const domain = normalizeDomain(String(body.domain));
    const webPort = Number(body.webPort || 13000);
    const healthPath = normalizePath(typeof body.healthPath === 'string' ? body.healthPath : '/api/health');
    const healthcheckUrl = typeof body.healthcheckUrl === 'string' && body.healthcheckUrl.trim()
      ? body.healthcheckUrl.trim()
      : `https://${domain}${healthPath}`;
    const appPath = typeof body.appPath === 'string' && body.appPath.trim()
      ? body.appPath.trim()
      : `/opt/${project.slug}-prod`;
    const releaseScriptPath = typeof body.releaseScriptPath === 'string' && body.releaseScriptPath.trim()
      ? body.releaseScriptPath.trim()
      : path.resolve(process.cwd(), 'scripts/local-prod-release.sh');
    const worktreeRoot = typeof body.worktreeRoot === 'string' && body.worktreeRoot.trim()
      ? body.worktreeRoot.trim()
      : deps.config?.worktreeBase || path.resolve(process.cwd(), '..', '.cds-worktrees');
    const composeProject = shellSafeName(`${project.slug}-prod`);
    const allowedBranch = typeof body.allowedBranch === 'string' && body.allowedBranch.trim()
      ? body.allowedBranch.trim()
      : project.gitDefaultBranch || 'main';
    const deployCommand = [
      `CDS_LOCAL_PROD_DOMAIN=${shellQuote(domain)}`,
      `CDS_LOCAL_PROD_PORT=${shellQuote(String(webPort))}`,
      `CDS_LOCAL_PROD_HEALTH_URL=${shellQuote(healthcheckUrl)}`,
      `CDS_LOCAL_PROD_DIR=${shellQuote(appPath)}`,
      `CDS_LOCAL_PROD_COMPOSE_PROJECT=${shellQuote(composeProject)}`,
      `CDS_LOCAL_PROD_PROJECT_SLUG=${shellQuote(project.slug)}`,
      `CDS_LOCAL_PROD_ALLOWED_BRANCH=${shellQuote(allowedBranch)}`,
      `CDS_WORKTREE_ROOT=${shellQuote(worktreeRoot)}`,
      shellQuote(releaseScriptPath),
    ].join(' ');
    const now = new Date().toISOString();
    const target: ReleaseTarget = {
      id: typeof body.id === 'string' && body.id.trim() ? body.id.trim() : `rt_${crypto.randomBytes(6).toString('hex')}`,
      projectId: project.id,
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : `${domain} 本机生产`,
      type: 'ssh',
      createdAt: now,
      updatedAt: now,
      createdBy: resolveActorFromRequest(req),
      isEnabled: body.isEnabled !== false,
      lifecycle: 'active',
      environment: 'production',
      isCanonical: body.isCanonical !== false,
      projectIdentity: releaseProjectIdentity(project),
      strategy: {
        mode: 'existing-script',
        command: deployCommand,
        detectedFrom: ['cds/scripts/local-prod-release.sh'],
      },
      ssh: {
        host: remoteHost.host.host,
        port: remoteHost.host.sshPort || 22,
        user: remoteHost.host.sshUser,
        privateKeyRef: remoteHost.host.id,
        appPath,
        deployCommand,
        rollbackCommand: '',
        healthcheckUrl,
      },
    };
    try {
      service.ensureDefaultPlans(target.projectId);
      res.status(201).json({
        target: recordReleaseTargetUpsert(
          { state: deps.stateService, history },
          target,
          { actor: resolveActorFromRequest(req) },
        ),
      });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.patch('/releases/targets/:id', (req, res) => {
    const existing = deps.stateService.getReleaseTarget(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'release target not found' });
      return;
    }
    if (rejectProjectMismatch(req, res, existing.projectId)) return;
    if (rejectUnscopedAiMutation(req, res)) return;
    const body = (req.body || {}) as Record<string, unknown>;
    const mergedBody = {
      projectId: existing.projectId,
      name: existing.name,
      host: existing.ssh?.host,
      port: existing.ssh?.port,
      user: existing.ssh?.user,
      privateKeyRef: existing.ssh?.privateKeyRef,
      appPath: existing.ssh?.appPath,
      deployCommand: existing.ssh?.deployCommand,
      rollbackCommand: existing.ssh?.rollbackCommand,
      healthcheckUrl: existing.ssh?.healthcheckUrl,
      isEnabled: existing.isEnabled,
      strategy: existing.strategy,
      environment: existing.environment,
      isCanonical: existing.isCanonical,
      ...body,
    };
    const strategy = parseReleaseStrategy(mergedBody);
    const strategyValidation = validateReleaseStrategy(strategy);
    if (strategyValidation) {
      res.status(400).json({ error: strategyValidation });
      return;
    }
    const validation = validateSshTargetBody(mergedBody, true);
    if (validation) {
      res.status(400).json({ error: validation });
      return;
    }
    if (rejectProjectMismatch(req, res, typeof mergedBody.projectId === 'string' ? mergedBody.projectId : undefined)) return;
    const projectId = String(mergedBody.projectId).trim();
    const project = deps.stateService.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: `project not found: ${projectId}` });
      return;
    }
    if (rejectPrivateKeyRefMismatch(
      req,
      res,
      deps.stateService,
      projectId,
      String(mergedBody.privateKeyRef).trim(),
    )) return;
    const updated: ReleaseTarget = {
      ...existing,
      projectId,
      name: String(mergedBody.name).trim(),
      isEnabled: mergedBody.isEnabled !== false,
      environment: normalizeEnvironment(mergedBody.environment),
      isCanonical: mergedBody.isCanonical !== false,
      projectIdentity: releaseProjectIdentity(project),
      strategy,
      ssh: {
        host: String(mergedBody.host).trim(),
        port: Number(mergedBody.port || 22),
        user: String(mergedBody.user).trim(),
        privateKeyRef: String(mergedBody.privateKeyRef).trim(),
        appPath: String(mergedBody.appPath).trim(),
        deployCommand: strategy.mode === 'existing-script' ? strategy.command!.trim() : '',
        rollbackCommand: strategy.mode === 'existing-script' && typeof mergedBody.rollbackCommand === 'string'
          ? mergedBody.rollbackCommand.trim()
          : '',
        healthcheckUrl: String(mergedBody.healthcheckUrl).trim(),
      },
    };
    try {
      res.json({
        target: recordReleaseTargetUpsert(
          { state: deps.stateService, history },
          updated,
          { actor: resolveActorFromRequest(req) },
        ),
      });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  /**
   * 目标配置变更历史。用来回答「健康检查地址是谁、什么时候改成现在这个值的」。
   * 归档路由已有的 archivedBy / archiveReason 只覆盖归档一件事，这里覆盖全部字段。
   */
  router.get('/releases/targets/:id/changes', (req, res) => {
    const existing = deps.stateService.getReleaseTarget(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'release target not found' });
      return;
    }
    if (rejectProjectMismatch(req, res, existing.projectId)) return;
    const limit = Number(req.query.limit);
    res.json({ changes: history.list(req.params.id, Number.isFinite(limit) ? limit : undefined) });
  });

  /**
   * 远端发布现场：读回 current / previous 指向的真实版本并与 CDS 台账比对。
   * 纯只读 —— 巡检每 5 分钟自己跑一轮，这个端点是「我现在就想看一眼」的入口。
   */
  router.get('/releases/targets/:id/remote-state', async (req, res) => {
    const existing = deps.stateService.getReleaseTarget(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'release target not found' });
      return;
    }
    if (rejectProjectMismatch(req, res, existing.projectId)) return;
    try {
      res.json(await service.readRemoteReleaseState(existing));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /**
   * 回收远端超期产物。这是往生产机器上 rm -rf 的写操作，比任何配置类端点都危险，
   * 所以 rejectUnscopedAiMutation 必须在（无 scope 的 AI key 不许碰）。
   * dryRun 是默认建议路径：先看回收计划，再决定要不要真删。
   */
  router.post('/releases/targets/:id/reclaim', async (req, res) => {
    const existing = deps.stateService.getReleaseTarget(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'release target not found' });
      return;
    }
    if (rejectProjectMismatch(req, res, existing.projectId)) return;
    if (rejectUnscopedAiMutation(req, res)) return;
    const body = (req.body || {}) as Record<string, unknown>;
    const maxRemovals = Number(body.maxRemovals);
    try {
      res.json(await service.reclaimRemoteReleaseArtifacts(existing, {
        dryRun: body.dryRun === true,
        ...(Number.isFinite(maxRemovals) ? { maxRemovals } : {}),
      }));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.delete('/releases/targets/:id', (req, res) => {
    const existing = deps.stateService.getReleaseTarget(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'release target not found' });
      return;
    }
    if (rejectProjectMismatch(req, res, existing.projectId)) return;
    if (rejectUnscopedAiMutation(req, res)) return;
    const runs = deps.stateService.getReleaseRuns({ targetId: req.params.id });
    if (runs.length > 0) {
      res.status(409).json({ error: 'target has release runs and cannot be deleted' });
      return;
    }
    if (!deps.stateService.removeReleaseTarget(req.params.id)) {
      res.status(404).json({ error: 'release target not found' });
      return;
    }
    // 目标没了，它那桶变更历史也必须清掉：每桶自身有条数上限，但桶的数量没有，
    // 只删目标不删桶就是另一种无界增长。
    history.forget(req.params.id);
    res.status(204).end();
  });

  router.post('/releases/targets/:id/archive', (req, res) => {
    const existing = deps.stateService.getReleaseTarget(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'release target not found' });
      return;
    }
    if (rejectProjectMismatch(req, res, existing.projectId)) return;
    if (rejectUnscopedAiMutation(req, res)) return;
    const body = (req.body || {}) as Record<string, unknown>;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 8) {
      res.status(400).json({ error: 'archive reason must contain at least 8 characters' });
      return;
    }
    const actor = resolveActorFromRequest(req);
    const archived = recordReleaseTargetUpsert(
      { state: deps.stateService, history },
      {
        ...existing,
        lifecycle: 'archived',
        isEnabled: false,
        isCanonical: false,
        archivedAt: new Date().toISOString(),
        archivedBy: actor,
        archiveReason: reason,
      },
      { actor, reason },
    );
    res.json({ target: archived });
  });

  router.post('/releases/branches/:branchId/preflight', async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    if (typeof body.targetId !== 'string' || !body.targetId.trim()) {
      res.status(400).json({ error: 'targetId is required' });
      return;
    }
    if (rejectBranchAndTargetMismatch(req, res, deps.stateService, req.params.branchId, body.targetId.trim())) return;
    try {
      const result = await service.preflight({
        branchId: req.params.branchId,
        targetId: body.targetId.trim(),
        previewUrl: typeof body.previewUrl === 'string' ? body.previewUrl : '',
        operator: resolveActorFromRequest(req),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/releases/branches/:branchId/runs', async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    if (typeof body.targetId !== 'string' || !body.targetId.trim()) {
      res.status(400).json({ error: 'targetId is required' });
      return;
    }
    if (rejectBranchAndTargetMismatch(req, res, deps.stateService, req.params.branchId, body.targetId.trim())) return;
    if (rejectUnscopedAiMutation(req, res)) return;
    try {
      const run = await service.startRelease({
        branchId: req.params.branchId,
        targetId: body.targetId.trim(),
        previewUrl: typeof body.previewUrl === 'string' ? body.previewUrl : '',
        operator: resolveActorFromRequest(req),
      });
      rememberCommitTime(run);
      res.status(202).json({ run, streamUrl: `/api/releases/runs/${run.releaseId}/stream` });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.get('/releases/runs', (req, res) => {
    const projectId = resolveReadableProjectId(req, res);
    if (projectId === false) return;
    res.json({
      runs: deps.stateService.getReleaseRuns({
        projectId,
        targetId: typeof req.query.targetId === 'string' ? req.query.targetId : undefined,
        branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
      }),
    });
  });

  router.get('/releases/runs/:id', (req, res) => {
    const run = deps.stateService.getReleaseRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'release run not found' });
      return;
    }
    if (rejectProjectMismatch(req, res, run.projectId)) return;
    res.json({ run });
  });

  router.post('/releases/runs/:id/rollback', async (req, res) => {
    const existing = deps.stateService.getReleaseRun(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'ReleaseRun not found' });
      return;
    }
    if (rejectProjectMismatch(req, res, existing.projectId)) return;
    if (rejectUnscopedAiMutation(req, res)) return;
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const targetReleaseId = typeof body.targetReleaseId === 'string' && body.targetReleaseId.trim()
        ? body.targetReleaseId.trim()
        : undefined;
      if (targetReleaseId) {
        const targetRun = deps.stateService.getReleaseRun(targetReleaseId);
        if (!targetRun) {
          res.status(404).json({ error: 'rollback target release run not found' });
          return;
        }
        if (rejectProjectMismatch(req, res, targetRun.projectId)) return;
      }
      const run = await service.startRollback(req.params.id, resolveActorFromRequest(req), targetReleaseId);
      res.status(202).json({ run, streamUrl: `/api/releases/runs/${run.releaseId}/stream` });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.post('/releases/runs/:id/retry', async (req, res) => {
    const source = deps.stateService.getReleaseRun(req.params.id);
    if (!source) {
      res.status(404).json({ error: 'ReleaseRun not found' });
      return;
    }
    if (rejectProjectMismatch(req, res, source.projectId)) return;
    if (rejectUnscopedAiMutation(req, res)) return;
    try {
      const run = await service.startRelease({
        branchId: source.branchId,
        targetId: source.targetId,
        previewUrl: source.artifact?.previewUrl || '',
        operator: resolveActorFromRequest(req),
      });
      rememberCommitTime(run);
      res.status(202).json({ run, streamUrl: `/api/releases/runs/${run.releaseId}/stream` });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  /**
   * 取消一次在途发布。
   *
   * 终态语义选「幂等成功」而不是 409，三条理由：
   *   1. 取消表达的是「让它停下」这个意图，run 已经停了就等于意图已达成，
   *      把它判成冲突会逼调用方去区分「取消失败」和「本来就停了」两种噪声；
   *   2. 终态判定的 SSOT 在 release-service（RELEASE_STATUS_TERMINAL + cancelRelease
   *      自身已对终态 run 幂等返回 ok），路由再判一次冲突就会在两处复制状态机；
   *   3. 前端与 AI 都可能重试（网络抖动 / 用户连点），幂等才让重试安全。
   * 是否真的掐断了执行体由响应体的 cancelled / alreadyTerminal 如实告知，信息不丢。
   */
  router.post('/releases/runs/:id/cancel', (req, res) => {
    const existing = deps.stateService.getReleaseRun(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'ReleaseRun not found' });
      return;
    }
    if (rejectProjectMismatch(req, res, existing.projectId)) return;
    if (rejectUnscopedAiMutation(req, res)) return;
    const alreadyTerminal = isReleaseRunTerminal(existing.status);
    let result;
    try {
      result = service.cancelRelease(req.params.id, resolveActorFromRequest(req));
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
      return;
    }
    if (!result.ok) {
      res.status(409).json({ error: result.reason || '取消发布失败' });
      return;
    }
    res.json({
      run: deps.stateService.getReleaseRun(req.params.id) || existing,
      cancelled: !alreadyTerminal,
      alreadyTerminal,
    });
  });

  router.get('/releases/runs/:id/stream', (req, res) => {
    const run = deps.stateService.getReleaseRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'release run not found' });
      return;
    }
    if (rejectProjectMismatch(req, res, run.projectId)) return;
    // 与分支部署流（routes/deployment-runs.ts）同一口径：显式 afterSeq 优先，没给才回落到
    // Last-Event-ID。这个回落不是锦上添花 —— EventSource 断线自动重连时只会带这个请求头，
    // 不会替调用方补 query，此前没有它的时候每次重连都从 seq 0 重放整份日志。
    const afterSeq = clampSeq(req.query.afterSeq ?? req.headers['last-event-id']);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'close',
      'X-Accel-Buffering': 'no',
    });
    // id 行必须排在 event/data 之前：浏览器逐行解析，分发事件时读的是当前缓冲里的 id。
    const send = (event: string, data: unknown, id?: number): void => {
      const idLine = id === undefined ? '' : `id: ${id}\n`;
      try { res.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
    };
    let lastSentSeq = afterSeq;
    const handler = (envelope: ReleaseEventEnvelope): void => {
      if (!envelope?.payload || envelope.payload.releaseId !== req.params.id) return;
      if (envelope.type === 'release.log') {
        const seq = envelope.payload.log.seq;
        // 断点续传的语义闸：客户端已经拿到 seq 及以前的日志，重连后不该再收一遍。
        if (seq <= lastSentSeq) return;
        lastSentSeq = seq;
        send(envelope.type, envelope.payload, seq);
        return;
      }
      // 状态事件刻意不走上面那道 seq 闸：seq 只在追加日志时自增，状态变更（含步骤推进
      // 复用的 release.status）根本不动它，按 seq 过滤会把状态更新整批丢掉。
      // 仍带 id，取当前 seq，保证断点不会因为收到一条状态事件而倒退。
      send(envelope.type, envelope.payload, envelope.payload.run.seq);
    };
    // 先注册再取快照：两步之间是纯同步的，中间不可能插入事件；反过来先发快照会在
    // 两步之间丢掉真实发生的日志 —— 重复可以靠 id 去重，丢失无法补救。
    releaseEvents.on('any', handler);
    const latestRun = deps.stateService.getReleaseRun(req.params.id) || run;
    // 快照必须带截断语义：日志有上限（RELEASE_MAX_LOGS）后，客户端拿着旧 afterSeq 重连时
    // 它要的那一段可能已经被丢掉了。只发 filter 出来的 logs 等于让客户端以为自己收全了，
    // 静默缺一段 —— 与分支侧 deployment-runs 的 getEventsAfter 同口径，truncated 必须如实说。
    send('snapshot', { run: latestRun, ...buildReleaseLogSnapshot(latestRun, afterSeq) });
    lastSentSeq = Math.max(lastSentSeq, latestRun.seq);
    const keepalive = setInterval(() => {
      try { res.write(':keepalive\n\n'); } catch { /* ignore */ }
    }, 10_000);
    req.on('close', () => {
      clearInterval(keepalive);
      releaseEvents.off('any', handler);
    });
  });

  router.get('/releases/center', async (req, res) => {
    const projectId = resolveReadableProjectId(req, res);
    if (projectId === false) return;
    if (projectId) service.ensureDefaultPlans(projectId);
    const targets = deps.stateService.getReleaseTargets(projectId);
    const runs = deps.stateService.getReleaseRuns(projectId ? { projectId } : {});
    const rows = await Promise.all(targets.map(async (target) => {
      const targetRuns = runs.filter((run) => run.targetId === target.id);
      // 成功判定与保留策略共用 isSuccessfulReleaseRun：两边一旦分裂，UI 上还看得见的
      // 版本会被淘汰器当成可删的，点下去直接「没有可回滚的上一版本」。
      const successfulRuns = targetRuns.filter(isSuccessfulReleaseRun);
      const current = successfulRuns[0];
      const latest = targetRuns[0];
      const latestIsSuccessful = latest ? isSuccessfulReleaseRun(latest) : false;
      const rollbackDefaultReleaseId = latestIsSuccessful && latest
        ? deps.stateService.getLatestSuccessfulReleaseRun(target.id, latest.releaseId)?.releaseId || ''
        : successfulRuns[0]?.releaseId || '';
      // 读存活监控的快照，不在这里打生产。理由见 release-health-snapshot.ts 顶部：
      // 「打开发布中心」是纯读动作，不该按目标数放大成一串对生产的外呼。
      const health = readReleaseHealthSnapshot(target);
      return {
        target,
        currentVersion: current?.releaseId || '',
        currentCommit: current?.commitSha || '',
        latestRun: latest,
        lastReleasedAt: current?.finishedAt || current?.startedAt || '',
        health,
        healthStatus: health.status,
        lastOperator: latest?.operator || '',
        canRollback: Boolean(rollbackDefaultReleaseId),
        // 下拉给出的版本数必须 = 保留策略保住的成功 run 数，不许再拍一个字面量。
        successfulRuns: successfulRuns.slice(0, KEEP_SUCCESSFUL_RELEASE_RUNS),
        rollbackDefaultReleaseId,
        // 发布 ETA 的传输面。少了这一行，采样照常在攒、前端却恒为 undefined，
        // 发布中心永远显示「正在积累历史耗时数据」——功能全链路建好却不可见。
        releaseEstimate: deps.stateService.getReleaseEstimate(target.id),
      };
    }));
    // DORA 四项的传输面。少了这一行，聚合照常能算、前端却恒为 undefined，
    // 发布中心永远显示「暂无指标」——同 releaseEstimate 那次的静默退化。
    // 刻意挂在 center 而不是新开端点：这个 handler 手里已经有全量 runs，
    // 零新增外呼、零新 API label，也保证指标和它下面那张发布记录表同源。
    const dora = computeReleaseDora(runs, {
      windowDays: clampDoraWindowDays(req.query.doraDays ?? DEFAULT_DORA_WINDOW_DAYS),
      resolveCommitAt: (run) => commitClock.get(run.projectId, run.commitSha),
    });
    res.json({ rows, plans: deps.stateService.getReleasePlans(projectId), runs: runs.slice(0, 50), dora });
  });

  return router;
}

/**
 * SSE 续传游标解析。
 *
 * 必须容错到「任何脏值都退回 0」：Last-Event-ID 是客户端可控的裸字符串，代理也可能
 * 把它变成数组。放任 NaN 流进 `log.seq > afterSeq` 会让比较恒 false，快照静默变空 ——
 * 表现是「重连后一条日志都没有」，而不是报错。
 */
function clampSeq(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(typeof raw === 'string' ? raw.trim() : raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(parsed));
}

function requestProjectKey(req: Request): { projectId: string; keyId: string } | undefined {
  return (req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } }).cdsProjectKey;
}

function rejectProjectMismatch(req: Request, res: Response, projectId: string | undefined): boolean {
  const mismatch = assertProjectAccess(req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } }, projectId);
  if (!mismatch) return false;
  res.status(mismatch.status).json(mismatch.body);
  return true;
}

/**
 * 全局 AI key 不得写入或执行项目发布。
 *
 * 除配置类端点外，执行类端点（发起发布 / 回滚 / 重试 / 取消）同样必须过这道门：
 * 它们能直接改动生产，权限不该比改一行发布目标配置还松。
 */
function rejectUnscopedAiMutation(req: Request, res: Response): boolean {
  const actor = resolveActorFromRequest(req);
  if (!(actor === 'ai' || actor.startsWith('ai:')) || requestProjectKey(req)) return false;
  res.status(403).json({
    error: 'project_key_required',
    message: 'AI 操作项目发布必须使用项目级 Agent Key，禁止用全局 AI key 配置或执行项目发布。',
  });
  return true;
}

function rejectPrivateKeyRefMismatch(
  req: Request,
  res: Response,
  stateService: StateService,
  projectId: string,
  privateKeyRef: string,
): boolean {
  const projectKey = requestProjectKey(req);
  if (!projectKey) return false;
  if (projectKey.projectId !== projectId) return false;
  const alreadyProvisionedForProject = stateService
    .getReleaseTargets(projectId, { includeArchived: true })
    .some((target) => target.ssh?.privateKeyRef === privateKeyRef);
  if (alreadyProvisionedForProject) return false;

  res.status(403).json({
    error: 'remote_host_scope',
    projectId,
    keyId: projectKey.keyId,
    message: '项目级 key 不能引入未由本项目发布目标使用过的服务器凭据，请先用系统权限创建发布目标。',
  });
  return true;
}

function resolveReadableProjectId(req: Request, res: Response): string | undefined | false {
  const queryProject = typeof req.query.project === 'string' ? req.query.project : undefined;
  const projectKey = requestProjectKey(req);
  const projectId = queryProject || projectKey?.projectId;
  if (rejectProjectMismatch(req, res, projectId)) return false;
  return projectId;
}

function rejectBranchAndTargetMismatch(
  req: Request,
  res: Response,
  stateService: StateService,
  branchId: string,
  targetId: string,
): boolean {
  const branch = stateService.getBranch(branchId);
  const target = stateService.getReleaseTarget(targetId);
  if (rejectProjectMismatch(req, res, branch?.projectId)) return true;
  if (rejectProjectMismatch(req, res, target?.projectId)) return true;
  return false;
}

function validateSshTargetBody(body: Record<string, unknown>, allowExisting: boolean): string | null {
  const required = ['projectId', 'name', 'host', 'user', 'privateKeyRef', 'appPath', 'healthcheckUrl'];
  for (const key of required) {
    if (typeof body[key] !== 'string' || !String(body[key]).trim()) {
      return `${key} is required`;
    }
  }
  const port = Number(body.port || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port must be an integer in [1, 65535]';
  const appPath = path.posix.normalize(String(body.appPath).trim());
  if (!path.posix.isAbsolute(appPath) || appPath === '/') return 'appPath must be an absolute project directory, not filesystem root';
  try {
    const url = new URL(String(body.healthcheckUrl));
    if (!['http:', 'https:'].includes(url.protocol)) return 'healthcheckUrl must be http or https';
  } catch {
    return 'healthcheckUrl must be a valid URL';
  }
  if (!allowExisting && typeof body.id === 'string' && body.id && !/^[A-Za-z0-9_-]{2,80}$/.test(body.id)) {
    return 'id must match [A-Za-z0-9_-]{2,80}';
  }
  return null;
}

function parseReleaseStrategy(body: Record<string, unknown>): ReleaseStrategy {
  const raw = body.strategy && typeof body.strategy === 'object'
    ? body.strategy as Record<string, unknown>
    : {};
  const mode = raw.mode === 'generated-compose' || raw.mode === 'generated-static' || raw.mode === 'existing-script'
    ? raw.mode
    : 'existing-script';
  if (mode === 'generated-compose') {
    return {
      mode,
      composeFile: typeof raw.composeFile === 'string' ? raw.composeFile.trim() : '',
      composeProject: typeof raw.composeProject === 'string' ? raw.composeProject.trim() : '',
      detectedFrom: stringArray(raw.detectedFrom),
    };
  }
  if (mode === 'generated-static') {
    return {
      mode,
      buildCommand: typeof raw.buildCommand === 'string' ? raw.buildCommand.trim() : '',
      artifactDirectory: typeof raw.artifactDirectory === 'string' ? raw.artifactDirectory.trim() : '',
      publicDirectory: typeof raw.publicDirectory === 'string' ? raw.publicDirectory.trim() : '',
      detectedFrom: stringArray(raw.detectedFrom),
    };
  }
  const command = typeof raw.command === 'string'
    ? raw.command.trim()
    : typeof body.deployCommand === 'string'
      ? body.deployCommand.trim()
      : '';
  return { mode, command, detectedFrom: stringArray(raw.detectedFrom) };
}

function normalizeEnvironment(value: unknown): ReleaseTarget['environment'] {
  return value === 'staging' || value === 'other' ? value : 'production';
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  return values.length > 0 ? values : undefined;
}

function validateLocalProdTargetBody(body: Record<string, unknown>): string | null {
  if (typeof body.projectId !== 'string' || !body.projectId.trim()) return 'projectId is required';
  if (typeof body.domain !== 'string' || !body.domain.trim()) return 'domain is required';
  const domain = normalizeDomain(String(body.domain));
  if (!/^[a-z0-9.-]+$/i.test(domain) || domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) {
    return 'domain must be a hostname';
  }
  const webPort = Number(body.webPort || 13000);
  if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535) {
    return 'webPort must be an integer in [1, 65535]';
  }
  if (typeof body.id === 'string' && body.id && !/^[A-Za-z0-9_-]{2,80}$/.test(body.id)) {
    return 'id must match [A-Za-z0-9_-]{2,80}';
  }
  if (typeof body.healthcheckUrl === 'string' && body.healthcheckUrl.trim()) {
    try {
      const url = new URL(body.healthcheckUrl.trim());
      if (!['http:', 'https:'].includes(url.protocol)) return 'healthcheckUrl must be http or https';
    } catch {
      return 'healthcheckUrl must be a valid URL';
    }
  }
  return null;
}

function resolveLocalProdRemoteHost(
  stateService: StateService,
  body: Record<string, unknown>,
): { host: RemoteHost } | { error: string } {
  const privateKeyRef = typeof body.privateKeyRef === 'string' ? body.privateKeyRef.trim() : '';
  if (privateKeyRef) {
    const host = stateService.getRemoteHost(privateKeyRef);
    if (!host) return { error: `remote host not found: ${privateKeyRef}` };
    if (!host.isEnabled) return { error: `remote host is disabled: ${privateKeyRef}` };
    return { host };
  }
  const enabledHosts = stateService.getRemoteHosts().filter((host) => host.isEnabled);
  if (enabledHosts.length === 1) return { host: enabledHosts[0] };
  if (enabledHosts.length === 0) return { error: 'no enabled remote host' };
  return { error: 'privateKeyRef is required when multiple remote hosts are enabled' };
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return parsed.hostname.toLowerCase();
  } catch {
    return trimmed.toLowerCase().replace(/^https?:\/\//, '').split('/')[0] || trimmed.toLowerCase();
  }
}

function normalizePath(value: string): string {
  const trimmed = value.trim() || '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function shellSafeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'app-prod';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
