/**
 * Executor local API routes — called by the Scheduler to execute operations.
 * These endpoints are the "hands" that do the actual Docker/Git work.
 */
import { Router } from 'express';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { BuildProfile } from '../types.js';
import type { StateService } from '../services/state.js';
import type { ContainerService } from '../services/container.js';
import { WorktreeService, deploymentNeedsSourceCheckout } from '../services/worktree.js';
import { worktreePathActivity } from '../services/worktree-path-activity.js';
import type { CdsConfig, IShellExecutor, BranchEntry, OperationLog, OperationLogEvent } from '../types.js';
import { topoSortLayers } from '../services/topo-sort.js';
import { admittedArtifactProfile, type ArtifactAdmission } from '../services/artifact-admission.js';
import { BranchOperationCoordinator, BranchOperationSupersededError, type BranchOperationTrigger } from '../services/branch-operation-coordinator.js';
import { normalizeProjectProfileDependencies } from '../services/project-profile-dependencies.js';
import { preserveServingRuntime, runtimeRef } from '../services/service-runtime.js';
import { prepareServiceReplacement, reserveServiceReplacements, replacementLaunchEntry, preserveReplacementNames, commitServiceReplacements } from '../services/service-replacement.js';
import { applyDeployReadinessFloor, resolveDeployReadinessFloorSeconds } from '../services/container.js';

export interface ExecutorRouterDeps {
  stateService: StateService;
  worktreeService: WorktreeService;
  containerService: ContainerService;
  shell: IShellExecutor;
  config: CdsConfig;
}

export function createExecutorRouter(deps: ExecutorRouterDeps): Router {
  const { stateService, worktreeService, containerService, shell, config } = deps;
  const router = Router();
  const preparations = new BranchOperationCoordinator();

  // ── Auth middleware: verify executor token ──
  router.use((req, res, next) => {
    if (config.executorToken) {
      const token = req.headers['x-executor-token'] as string | undefined;
      if (token !== config.executorToken) {
        res.status(401).json({ error: 'Invalid executor token' });
        return;
      }
    }
    next();
  });

  // FU-04 isolation sweep (2026-04-24): customEnv MUST be scoped by
  // the deploying project. Calling getCustomEnv() with no scope only
  // returns the _global baseline and silently drops every per-project
  // override — so a deploy for project B would never see B's secrets
  // unless master happened to ship them in envOverrides. Master does
  // ship the merged env today so this isn't actively exploitable, but
  // any future code path that calls getMergedEnv without overrides
  // would skip the project layer. Cleanly threading projectId here
  // makes the executor self-sufficient and matches master's
  // branches.ts:357 behaviour.
  function getMergedEnv(projectId: string): Record<string, string> {
    const cdsEnv = stateService.getCdsEnvVars(projectId);
    const mirrorEnv = stateService.getMirrorEnvVars();
    const customEnv = stateService.getCustomEnv(projectId);
    return { ...cdsEnv, ...mirrorEnv, ...customEnv };
  }

  // ── GET /exec/status — current load and branch status ──
  router.get('/status', (_req, res) => {
    const branches = stateService.getAllBranches();
    const branchStatus: Record<string, { status: string; services: Record<string, unknown> }> = {};
    for (const b of branches) {
      branchStatus[b.id] = { status: b.status, services: b.services };
    }
    res.json({ branches: branchStatus });
  });

  // 只核验产物，不创建worktree、容器或修改项目/分支状态；使用本执行器daemon及registry访问。
  router.post('/artifact-preflight', async (req, res) => {
    const { profiles, commitSha } = req.body || {};
    if (!Array.isArray(profiles) || profiles.length > 256 || typeof commitSha !== 'string' || !/^[0-9a-f]{40}$/i.test(commitSha)
      || !profiles.every(profile => profile && typeof profile.id === 'string' && profile.id.length <= 256
        && typeof profile.dockerImage === 'string' && profile.dockerImage.length <= 4096)) {
      res.status(400).json({ error: '产物核验输入无效' }); return;
    }
    try {
      const result = await containerService.inspectDeploymentArtifacts(profiles as BuildProfile[], commitSha, () => {});
      res.json(result);
    } catch {
      res.status(503).json({ error: '产物核验暂不可用，尚未开始部署' });
    }
  });

  // ── POST /exec/deploy — deploy a branch (create worktree + build + run) ──
  router.post('/deploy', async (req, res) => {
    const { branchId, branchName, projectId, profiles: profilesRaw, env: envOverrides, requestId, operationId, actor, trigger, commitSha, artifactCommitSha } = req.body as {
      branchId: string;
      branchName: string;
      commitSha?: string;
      artifactCommitSha?: string;
      // P4 follow-up (2026-04-24): master now passes projectId so the
      // executor stamps the right scope onto its local entry. Older
      // masters that omit this field still work via the
      // `resolveProjectForAutoBuild` fallback below — same shape as the
      // subdomain auto-build path in index.ts.
      projectId?: string;
      profiles: BuildProfile[];
      env?: Record<string, string>;
      requestId?: string | null;
      operationId?: string | null;
      actor?: string | null;
      trigger?: string | null;
    };
    if (commitSha !== undefined && (typeof commitSha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(commitSha))) {
      res.status(400).json({ error: '目标提交必须是有效的 Git SHA' });
      return;
    }
    if (artifactCommitSha !== undefined && (typeof artifactCommitSha !== 'string' || !/^[0-9a-f]{40}$/i.test(artifactCommitSha))) {
      res.status(400).json({ error: '产物目标必须是完整 Git SHA' }); return;
    }
    // 缺省 profiles 视为空清单（Bugbot Low「Executor deploy missing profiles guard」）：旧 master 或手工
    // 调用可能省略 profiles 字段,profilesData.map / .length 直接 throw → 把一次合法的「空清单 teardown」
    // 变成不透明的部署错误。归一为 []，让下方孤儿收敛 + 空清单落 idle 的路径正常走。
    let profilesData = Array.isArray(profilesRaw) ? profilesRaw : [];

    // SSE response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendEvent = (event: string, data: unknown) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* */ }
    };

    let preparation: ReturnType<BranchOperationCoordinator['beginDeploymentPreparation']> | undefined;
    let admission: ArtifactAdmission | undefined;
    let executionStarted = false;
    let currentEntry = stateService.getBranch(branchId);
    let expectedProject = currentEntry?.projectId, expectedBranch = currentEntry?.branch;
    const target = artifactCommitSha ?? commitSha;
    const assertCurrent = () => {
      preparation?.assertCurrent();
      if (stateService.getBranch(branchId) !== currentEntry
        || (currentEntry && (currentEntry.projectId !== expectedProject || currentEntry.branch !== expectedBranch))) throw new BranchOperationSupersededError('', branchId, 'executor-owner');
    };
    try {
      // Ensure worktree exists.
      // P4 Part 18 (G1.2): executor routes stay on the single
      // config.repoRoot. A remote executor is a separately-hosted
      // node pinned to a single bind-mounted repo; per-project clone
      // lives on the master and is not replicated to executors yet.
      //
      // FU-04 follow-up (2026-04-24): the worktree directory + entry
      // projectId must reflect the *real* project, not a hardcoded
      // 'default'. Otherwise renaming the legacy project on master
      // turns every executor-created entry into an orphan (project id
      // points at nothing → settings page 404 + "遗留 default" banner
      // re-appears). Resolution order:
      //   1. projectId in request body (master >= 2026-04-24)
      //   2. resolveProjectForAutoBuild against config.repoRoot
      //      (legacyFlag → repoPath match → no-repoPath → only project)
      // If none unambiguously matches, refuse rather than orphan.
      let resolvedProjectId = projectId;
      if (!resolvedProjectId) {
        const owner = stateService.resolveProjectForAutoBuild(config.repoRoot);
        if (!owner) {
          sendEvent('error', {
            message: `无法为分支 ${branchName} 定位所属项目（master 未传 projectId 且本地项目状态无法唯一识别）`,
          });
          res.end();
          return;
        }
        resolvedProjectId = owner.id;
      }

      // 新 master 会在派发前完成归一化；这里再做一次兼容，覆盖旧 master、
      // 手工调用和 executor 已同步项目元数据的场景。后续拓扑排序只消费
      // 归一化后的依赖，避免 Web 先于 Console/Serving 启动。
      const executorProject = stateService.getProject(resolvedProjectId);
      const executorProfileSuffix = resolvedProjectId === 'default'
        ? ''
        : `-${executorProject?.slug || resolvedProjectId}`;
      profilesData = normalizeProjectProfileDependencies(profilesData, executorProfileSuffix);
      const actualProjectId = currentEntry?.projectId || resolvedProjectId;
      if (artifactCommitSha && commitSha && (!/^[0-9a-f]{40}$/i.test(commitSha) || artifactCommitSha.toLowerCase() !== commitSha.toLowerCase())) {
        sendEvent('error', { code: 'artifact_target_unresolved', accepted: false, retryable: true, message: '请求目标与产物目标不一致，尚未受理；请使用Master确认的完整目标重试' }); return;
      }
      const requiresArtifactAdmission = profilesData.some(profile => profile.prebuiltImage && !profile.managedBuild);
      if (requiresArtifactAdmission && (typeof target !== 'string' || !/^[0-9a-f]{40}$/i.test(target))) {
        sendEvent('error', { code: 'artifact_target_unresolved', accepted: false, retryable: true,
          message: '预构建部署的完整目标尚未确认，尚未受理；请由Master等待齐备产物后重试，旧服务继续保留',
          ...(currentEntry ? { services: currentEntry.services } : {}) }); return;
      }
      const allowedTriggers: BranchOperationTrigger[] = ['manual', 'webhook', 'auto-lifecycle', 'scheduler', 'janitor', 'system'];
      preparation = preparations.beginDeploymentPreparation({ branchId, projectId: actualProjectId, kind: 'deploy',
        trigger: allowedTriggers.includes(trigger as BranchOperationTrigger) ? trigger as BranchOperationTrigger : 'manual',
        actor, requestId, commitSha: typeof target === 'string' && /^[0-9a-f]{7,40}$/i.test(target) ? target : null,
        commitPinned: typeof target === 'string', source: 'executor.deploy' });
      // 全角色核验先于工作树、旧容器清理和分支状态修改；local标记也不是身份凭据。
      if (requiresArtifactAdmission) {
        sendEvent('step', { step: 'artifact-preflight', status: 'running', title: '正在核验全部必需镜像及本地产物' });
        try {
          admission = await containerService.inspectDeploymentArtifacts(profilesData as BuildProfile[], target!, assertCurrent, { inspectLocalArtifacts: true });
        } catch (error) {
          assertCurrent();
          if (error instanceof BranchOperationSupersededError) throw error;
          admission = { state: 'waiting', targetCommitSha: target!, checkedAt: new Date().toISOString(), reason: 'verification-unavailable', artifacts: [] };
        }
        assertCurrent();
        if (admission.state !== 'ready') {
          sendEvent('error', { code: 'artifact_not_ready', accepted: false, retryable: true, reason: admission.reason, profileIds: admission.profileIds,
            message: '必需产物尚未通过核验，尚未受理；请由Master等待正确产物后重试，旧服务继续保留',
            ...(currentEntry ? { services: currentEntry.services } : {}) }); return;
        }
        profilesData = profilesData.map(profile => profile.prebuiltImage && !profile.managedBuild
          ? admittedArtifactProfile({ ...profile, localArtifact: false } as BuildProfile, admission) : profile);
        sendEvent('step', { step: 'artifact-preflight', status: 'done', title: '全部必需产物已核验，固定内容后部署' });
      }
      assertCurrent();

      // Admission stamps immutable runtime images localArtifact=true; that alone is not a source dependency.
      // Classify the accepted profiles using the same host-file dependency rule as the Master.
      const artifactOnly = admission?.state === 'ready' && !deploymentNeedsSourceCheckout(profilesData.map(profile =>
        profile.prebuiltImage && !profile.managedBuild ? { ...profile, localArtifact: false } : profile));
      let entry = currentEntry;
      if (!entry) {
        assertCurrent(); executionStarted = true;
        const worktreePath = WorktreeService.worktreePathFor(config.worktreeBase, resolvedProjectId, branchId);
        entry = await worktreePathActivity.withClaim([worktreePath, WorktreeService.deploymentSourceRootFor(worktreePath)], async () => {
          if (!artifactOnly) {
            sendEvent('step', { step: 'worktree', status: 'running', title: `正在为 ${branchName} 创建工作树...` });
            await shell.exec(`mkdir -p "${config.worktreeBase}/${resolvedProjectId}"`);
            assertCurrent(); await worktreeService.create(config.repoRoot, branchName, worktreePath); assertCurrent();
          }

          const entry: BranchEntry = {
            id: branchId,
            projectId: resolvedProjectId,
            branch: branchName,
            worktreePath,
            services: {},
            status: 'building',
            createdAt: new Date().toISOString(),
          };
          assertCurrent();
          stateService.addBranch(entry); currentEntry = entry; expectedProject = entry.projectId; expectedBranch = entry.branch;
          stateService.save();
          if (!artifactOnly) sendEvent('step', { step: 'worktree', status: 'done', title: '工作树已创建' });
          return entry;
        });
      }

      // 进入部署窗口立即把 worker 分支态钉成 building（Bugbot「Executor deploy skips building status」）：
      // 孤儿收敛 + pull 都在 status=building 之前发生，原先 building 只在 pull 成功后才设，这段窗口里 worker
      // 副本仍是上一轮的 running/idle，心跳会把它同步到 master、覆盖 master 派发时钉的 building，UI 在大半个
      // 部署期看不出「构建中」。在拆容器/pull 之前就钉 building，让心跳同步过去的也是 building。
      assertCurrent(); executionStarted = true;
      for (const service of Object.values(entry.services)) preserveServingRuntime(service);
      entry.status = 'building';
      stateService.save();

      const removeAcceptedOrphans = async () => {
      // 非空图在本执行器完成存储准入后才清孤儿；空清单仍走独立清空路径。
      const payloadProfileIds = new Set(profilesData.map((p) => p.id));
      for (const [sid, svc] of Object.entries(entry.services)) {
        if (payloadProfileIds.has(sid)) continue;
        assertCurrent();
        try {
          await containerService.removeRuntimeGroup(svc, {
            projectId: entry.projectId,
            branchId: entry.id,
            profileId: sid,
            requestId: requestId || null,
            operationId: operationId || null,
            actor: actor || 'executor',
            trigger: trigger || 'executor-deploy',
            operation: 'executor-deploy-remove-orphan-service',
            source: 'executor.deploy',
            assertCurrent,
            reason: '服务已从期望清单移除(额外服务被清/项目 profile 被删)',
          });
        } catch (error) {
          if (error instanceof BranchOperationSupersededError) throw error;
        }
        assertCurrent();
        delete entry.services[sid];
        sendEvent('step', { step: 'remove-orphan-service', status: 'done', title: `服务 "${sid}" 已下掉（已从期望清单移除）` });
      }
      stateService.save();

      };
      // 期望清单为空 = 纯清空（如清掉最后一个额外服务）：没有要构建的东西，跳过 pull（避免 git 瞬时失败/分支
      // 被上游删除把一次成功的清空翻成 error），直接落 idle + complete 返回。
      if (profilesData.length === 0) {
        await removeAcceptedOrphans();
        entry.status = 'idle';
        entry.errorMessage = undefined;
        entry.lastAccessedAt = new Date().toISOString();
        stateService.save();
        sendEvent('complete', { message: '已清空所有服务', services: entry.services });
        return; // finally 里 res.end()
      }

      let pullResult: { head: string; after: string; afterFull: string; sourcePath: string };
      if (artifactOnly) {
        const targetCommit = admission!.targetCommitSha;
        pullResult = { head: targetCommit, after: targetCommit.slice(0, 7), afterFull: targetCommit, sourcePath: entry.worktreePath };
        sendEvent('step', { step: 'artifact-target', status: 'done', title: `本次直接部署已核验产物 ${targetCommit.slice(0, 7)}`, artifactCommitSha: targetCommit });
      } else {
        // 产物部署未建工作树；首次明确切源码时只为既有内部工作树路径创建，不处理外部路径。
        if (entry.worktreePath === WorktreeService.worktreePathFor(config.worktreeBase, entry.projectId || resolvedProjectId, branchId)) {
          let missing = false;
          try { await access(path.join(entry.worktreePath, '.git')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true; else throw error; }
          assertCurrent();
          if (missing) { await worktreeService.create(config.repoRoot, entry.branch, entry.worktreePath); assertCurrent(); }
        }
        sendEvent('step', { step: 'pull', status: 'running', title: '正在拉取最新代码...' });
        pullResult = await worktreeService.prepareDeploymentSource(entry.branch, entry.worktreePath, admission?.targetCommitSha || commitSha);
        assertCurrent();
        sendEvent('step', { step: 'pull', status: 'done', title: `已拉取: ${pullResult.head}`,
          head: pullResult.head, after: pullResult.after, afterFull: pullResult.afterFull });
      }

      const storageEntry = {...entry, worktreePath: pullResult.sourcePath};
      profilesData = await containerService.preflightDeploymentStorage(storageEntry,
        profilesData.map(profile=>({...profile,projectId:actualProjectId} as BuildProfile)),
        {assertCurrent,sourceCommitSha:pullResult.afterFull,operationId:operationId || undefined,
          customEnv:{...getMergedEnv(actualProjectId),...(envOverrides || {})},
          onOutput:(profileId,chunk)=>sendEvent('log',{profileId,chunk})});
      await removeAcceptedOrphans();

      assertCurrent();
      entry.status = 'building';
      // 盖本轮构建起点锚点：executor 本地也跑 reconcileStuckDeployStates，其硬超时路径要求
      // lastDeployStartedAt>0 才有超时基准。executor-owned 分支若不盖戳，卡在 building/starting
      // 的远端构建就没有超时锚点、永不被本地看门狗收敛，master 侧的修正又会被 executor 心跳覆盖
      // （Codex P2「Stamp executor deploy starts before relying on the watchdog」）。与 master 侧
      // 各 deploy 入口的 lastDeployStartedAt 盖戳口径一致。
      entry.lastDeployStartedAt = new Date().toISOString();
      stateService.save();

      // Pre-allocate ports
      for (const profile of profilesData) {
        if (!entry.services[profile.id]) {
          const hostPort = stateService.allocatePort(config.portStart);
          entry.services[profile.id] = {
            profileId: profile.id,
            containerName: `cds-${branchId}-${profile.id}`,
            hostPort,
            status: 'idle',
          };
        }
      }
      stateService.save();

      reserveServiceReplacements({ entry, profileIds: profilesData.map(profile => profile.id), state: stateService,
        portStart: config.portStart, operationId: operationId || undefined });
      await stateService.flush();
      // Build and run each profile
      // PR #498 round-6 review (Bugbot): env scope must follow the
      // entry's actual projectId (preserved as source of truth), not
      // the request-derived resolvedProjectId. For a re-deploy of an
      // existing entry whose projectId differs from what the master
      // sent (or what resolveProjectForAutoBuild guessed for older
      // masters), using resolvedProjectId would inject env vars from
      // the wrong project's scope.
      const mergedEnv = { ...getMergedEnv(entry.projectId || resolvedProjectId), ...(envOverrides || {}) };

      const runningInfraIds = new Set(
        stateService.getInfraServicesForProject(entry.projectId || resolvedProjectId)
          .filter((service) => service.status === 'running')
          .map((service) => service.id),
      );
      const { layers, warnings } = topoSortLayers(
        profilesData,
        (profile) => profile.id,
        (profile) => profile.dependsOn || [],
        runningInfraIds,
      );
      sendEvent('step', {
        step: 'startup-plan',
        status: 'info',
        title: `启动计划: ${layers.length} 层, ${profilesData.length} 服务`,
        layers: layers.map((layer) => ({ layer: layer.layer, services: layer.items.map((profile) => profile.id) })),
        ...(warnings.length > 0 ? { warnings } : {}),
      });

      for (const layer of layers) {
        sendEvent('step', {
          step: `startup-layer-${layer.layer}`,
          status: 'running',
          title: `启动第 ${layer.layer} 层`,
        });
        for (const profile of layer.items) {
          sendEvent('step', { step: `build-${profile.id}`, status: 'running', title: `正在构建 ${profile.name}...` });
          const svc = entry.services[profile.id];
          svc.status = 'building';

          // PR_B.1：BuildProfile.projectId 改为必填，executor 接收的 profile
          // 没有这个字段 — 用 resolvedProjectId（与 entry.projectId 同源）补上。
          const profileWithProject = profile as BuildProfile;
          try {
            const target = await prepareServiceReplacement({ entry, service: svc, profile: profileWithProject,
              state: stateService, container: containerService, portStart: config.portStart,
              operationId: operationId || undefined, assertCurrent });
            if (target !== svc) {
              svc.pendingRuntime = runtimeRef(target);
              stateService.save([{ kind: 'branches', id: entry.id }]); await stateService.flush();
            }
            await containerService.runService(replacementLaunchEntry(entry), profileWithProject, target, (chunk) => {
              sendEvent('log', { profileId: profile.id, chunk });
            }, mergedEnv, {
              requestId: requestId || null,
              operationId: operationId || null,
              assertCurrent,
              artifactCommitSha: admission?.targetCommitSha,
              sourceCheckout: artifactOnly ? undefined : { path: pullResult.sourcePath, commitSha: pullResult.afterFull },
              actor: actor || 'executor',
              trigger: trigger || 'executor-deploy',
              preserveContainerNames: preserveReplacementNames(entry, target),
              onRuntimeCreated: target !== svc ? async runtime => {
                assertCurrent(); svc.pendingRuntime = runtimeRef(runtime);
                stateService.save([{ kind: 'branches', id: entry.id }]); await stateService.flush(); assertCurrent();
              } : undefined,
            });

            assertCurrent();
            if (target !== svc) { Object.assign(svc, target); svc.pendingRuntime = undefined; }
            svc.status = 'starting';
            stateService.save([{ kind: 'branches', id: entry.id }]); await stateService.flush();
            const signalReady = !profile.startupSignal || await containerService.waitForStartupSignal(svc.containerName, profile.startupSignal);
            const ready = signalReady && await containerService.waitForReadiness(svc.hostPort,
              applyDeployReadinessFloor(profile.readinessProbe, resolveDeployReadinessFloorSeconds(
                stateService.getState().deployReadinessFloorSeconds,
                stateService.getProject(entry.projectId || resolvedProjectId)?.deployReadinessFloorSeconds)),
              undefined, undefined, svc.containerName);
            assertCurrent();
            if (!ready) throw new Error('候选服务未通过就绪检查，保留旧入口');
            svc.status = 'running';
            svc.errorMessage = undefined;
            sendEvent('step', { step: `build-${profile.id}`, status: 'done', title: `${profile.name} 运行于 :${svc.hostPort}` });
          } catch (err) {
            if (err instanceof BranchOperationSupersededError) throw err;
            assertCurrent();
            svc.status = 'error';
            svc.errorMessage = (err as Error).message;
            sendEvent('step', { step: `build-${profile.id}`, status: 'error', title: `${profile.name} 失败`, log: (err as Error).message });
          }
        }
        sendEvent('step', {
          step: `startup-layer-${layer.layer}`,
          status: 'done',
          title: `第 ${layer.layer} 层完成`,
        });
      }

      // 注：期望清单收敛（移除 payload 之外的孤儿服务容器）已上移到 pull 之前，避免 git 失败把
      // 已移除服务留成 ghost（Codex P2「Run executor cleanup before git pull」）。

      // Update overall status
      assertCurrent();
      await commitServiceReplacements({ entry, profileIds: profilesData.map(profile => profile.id), state: stateService,
        container: containerService, assertCurrent });
      const statuses = Object.values(entry.services).map(s => s.status);
      // 无服务(期望清单为空 / 已全部收敛拆除) → idle，与 master 端空清单清理一致（Bugbot Medium）：
      // 否则空 services 会落到 'error'，心跳同步把一次成功的「清空」误标为失败。
      // error 优先于 running：running+error 混合落 error，与 master reconcile + 本地 finalize 同口径
      // （Bugbot「Remote deploy ignores service errors」），不能任一 running 就报 running。
      entry.status = statuses.length === 0
        ? 'idle'
        : statuses.some(s => s === 'error') ? 'error'
        : statuses.some(s => s === 'running') ? 'running'
        : 'error';
      entry.lastAccessedAt = new Date().toISOString();
      stateService.save();

      sendEvent('complete', {
        message: entry.status === 'running'
          ? '部署完成'
          : entry.status === 'idle'
            ? '已清空所有服务'
            : '部分服务失败',
        services: entry.services,
      });
    } catch (err) {
      // 失败也回传当前权威 services 快照（Bugbot「Remote deploy error stale services」）：孤儿收敛已上移到
      // pull 之前，pull 失败时 worker 上被移除的服务已删，但 master 只从事件里的 services 对账；不带 services
      // 的 error 会让控制面把已移除的服务一直标 running/错端口到下次心跳。entry 可能尚未取到（极早失败）则省略。
      const failedEntry = stateService.getBranch(branchId);
      let stillCurrent = true; try { assertCurrent(); } catch { stillCurrent = false; }
      if (!stillCurrent || err instanceof BranchOperationSupersededError) {
        sendEvent('error', { code: 'target_request_superseded', accepted: false, retryable: false,
          message: '部署准备已被较新请求或停止操作取代，旧请求不再继续；请查看最新任务',
          ...(failedEntry ? { services: failedEntry.services } : {}) }); return;
      }
      if (failedEntry && executionStarted && stillCurrent && !(err instanceof BranchOperationSupersededError)) {
        // 把 worker 自身的分支态落到 error（含 errorMessage）（Bugbot「Failed remote deploy reverts to
        // building」）：部署前在 pre-allocate 处钉了 building，pull/构建失败时若不改，worker 副本停在
        // building，下一次心跳会把 master 已 finalize 的 error 覆盖回 building（心跳以 worker status 为准）。
        // 与 master finally 失败兜底同口径，让心跳同步过去的也是 error。
        failedEntry.status = 'error';
        if (!failedEntry.errorMessage) failedEntry.errorMessage = (err as Error).message;
        stateService.save();
      }
      sendEvent('error', {
        message: (err as Error).message,
        ...(failedEntry ? { services: failedEntry.services } : {}),
      });
    } finally {
      preparation?.release();
      res.end();
    }
  });

  // ── POST /exec/stop — stop all services for a branch ──
  router.post('/stop', async (req, res) => {
    const { branchId, requestId, operationId, actor, trigger } = req.body as {
      branchId: string;
      requestId?: string | null;
      operationId?: string | null;
      actor?: string | null;
      trigger?: string | null;
    };
    preparations.cancelBranch(branchId, '执行器终止请求');
    const entry = stateService.getBranch(branchId);
    if (!entry) {
      res.status(404).json({ error: `Branch "${branchId}" not found on this executor` });
      return;
    }

    try {
      for (const svc of Object.values(entry.services)) {
        // 先翻 stopping 再 await stop()。stop() 重构后容器停止仍保留(exited)，
        // 执行器进程同样跑 auto-restart 巡检，若此处仍 running，30s tick 命中
        // await 窗口会把主动停止误判为 crash 并 docker start 抢跑
        // （Codex P1，与 coolFn / auto-lifecycle / 手动 /stop 同款修复）。
        svc.status = 'stopping';
        try {
          await containerService.stopRuntimeGroup(svc, '执行器停止（保留容器，可秒级唤醒）', {
            kind: 'cds-stop',
            projectId: entry.projectId,
            branchId: entry.id,
            profileId: svc.profileId,
            requestId: requestId || null,
            operationId: operationId || null,
            actor: actor || 'executor',
            trigger: trigger || 'executor-stop',
            operation: 'executor-stop-branch',
            source: 'executor.stop',
          });
        } catch { /* ok */ }
        svc.status = 'stopped';
      }
      entry.status = 'idle';
      stateService.save();
      res.json({ message: 'All services stopped' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /exec/pull — pull latest code for a branch ──
  router.post('/pull', async (req, res) => {
    const { branchId, requestId, operationId, actor, trigger } = req.body as {
      branchId: string;
      requestId?: string | null;
      operationId?: string | null;
      actor?: string | null;
      trigger?: string | null;
    };
    const entry = stateService.getBranch(branchId);
    if (!entry) {
      res.status(404).json({ error: `Branch "${branchId}" not found` });
      return;
    }
    try {
      const result = await worktreeService.pull(entry.branch, entry.worktreePath);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── GET /exec/logs/:branchId — get container logs ──
  router.get('/logs/:branchId', async (req, res) => {
    const { branchId } = req.params;
    const { profileId } = req.query as { profileId?: string };
    const entry = stateService.getBranch(branchId);
    if (!entry) {
      res.status(404).json({ error: `Branch "${branchId}" not found` });
      return;
    }
    const svc = profileId ? entry.services[profileId] : Object.values(entry.services)[0];
    if (!svc) {
      res.status(404).json({ error: 'No service found' });
      return;
    }
    try {
      const logs = await containerService.getLogs(svc.containerName);
      res.json({ logs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /exec/delete — delete branch (stop + remove worktree) ──
  router.post('/delete', async (req, res) => {
    const { branchId, requestId, operationId, actor, trigger } = req.body as {
      branchId: string;
      requestId?: string | null;
      operationId?: string | null;
      actor?: string | null;
      trigger?: string | null;
    };
    const entry = stateService.getBranch(branchId);
    if (!entry) {
      preparations.cancelBranch(branchId, '执行器终止请求');
      res.status(404).json({ error: `Branch "${branchId}" not found` });
      return;
    }
    try { stateService.assertBranchStorageRemovalAllowed(branchId); }
    catch (error) { res.status(409).json({error:'storage_retained_branch_delete_refused',message:(error as Error).message}); return; }
    preparations.cancelBranch(branchId, '执行器终止请求');
    try {
      for (const svc of Object.values(entry.services)) {
        try {
          await containerService.removeRuntimeGroup(svc, {
            projectId: entry.projectId,
            branchId: entry.id,
            profileId: svc.profileId,
            requestId: requestId || null,
            operationId: operationId || null,
            actor: actor || 'executor',
            trigger: trigger || 'executor-delete',
            operation: 'executor-delete-branch',
            source: 'executor.delete',
            reason: `执行器删除分支 ${branchId}`,
          });
        } catch { /* ok */ }
      }
      // P4 Part 18 (G1.2): executor stays on config.repoRoot.
      try { await worktreeService.remove(config.repoRoot, entry.worktreePath); } catch { /* ok */ }
      // 分支专属网(cds-br-<id>)是在**本执行器**的 docker host 上创建的;主节点的 finalizeBranchDelete
      // 只清主节点那张(本地不存在=no-op),清不到这里。必须由执行器自己删,否则 worker 节点上隔离网
      // 随分支删除不断堆积(Bugbot Medium,2026-06-29)。容器上面已 remove,此时网可安全删;best-effort。
      try { await containerService.removeBranchNetwork(branchId, entry.replacementNetworks); } catch { /* ok */ }
      stateService.removeLogs(branchId);
      stateService.removeBranch(branchId);
      stateService.save();
      res.json({ message: `Branch "${branchId}" deleted` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /exec/infra/start — start an infra service ──
  router.post('/infra/start', async (req, res) => {
    const { service, customEnv } = req.body as {
      service: unknown;
      // Phase 1 (2026-05-01):远程 master 把项目 customEnv 一起 RPC 过来,
      // 让 worker 的 ${VAR} 展开拿到正确值。老 master 不传 customEnv 时
      // worker 走原行为(env 字面量)— 不破坏老调用方。
      customEnv?: Record<string, string>;
    };
    try {
      const svc = service as import('../types.js').InfraService;
      await containerService.startInfraService(svc, customEnv);
      res.json({ message: 'Service started' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /exec/infra/stop — stop an infra service ──
  router.post('/infra/stop', async (req, res) => {
    const { containerName } = req.body as { containerName: string };
    try {
      // /exec/infra/stop 是远端停止，不接重建，意图记 stop。
      await containerService.stopInfraService(containerName, 'cds-infra-stop');
      res.json({ message: 'Service stopped' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
