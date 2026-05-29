// 项目基础设施重新同步路由 (2026-05-29)
//
// 用户反馈:"我想重新初始化这个项目, 比如彻底重装这个数据库啊, 基础设施什么的,
// 怎么操作呢? 当然数据库不丢失, 目前缺乏一个重新从 cds-compose.yml 初始化的功能,
// 就比如 openvisual 出现的, 需要回收 2 个基础设施, 忽然发现, 没有地方可以这样做"
//
// 设计决策(与用户问卷确认):
//   1. yaml 源:支持 PendingImport(最近 3 条已审批)+ 上传/粘贴 yaml,两种皆走
//      cmd 白名单校验
//   2. removes 默认全勾选,但 execute 必须接 confirmText='yes'
//   3. update 触发条件:image / cmd / entrypoint / env / hostPort / containerPort
//      / volumes / restartPolicy 任一变化 → 重建。**数据卷(docker named volume)
//      保留**,新容器挂同名 volume 自动接回。
//
// API:
//   POST /api/projects/:id/infra/resync/preview
//     body: { composeYaml: string }   // 来源不影响后端,前端二选一
//     → 200 { adds: [...], updates: [{id, reasons[]}, ...], removes: [...],
//             noChange: [...], cmdValidationError?: string }
//
//   POST /api/projects/:id/infra/resync/execute
//     body: { composeYaml: string, confirmText?: string }
//     → 200 { applied: { added: [], updated: [], removed: [] }, errors: [] }
//
// 安全:
//   - cmd 白名单(minio/elasticsearch 缺 cmd → 400)
//   - removes 非空时 confirmText 必须 === 'yes'
//   - 全程审计写 serverEventLogStore + cds-events bus

import { Router } from 'express';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import type { StateService } from '../services/state.js';
import type { InfraService } from '../types.js';
import { parseCdsCompose, discoverComposeFiles } from '../services/compose-parser.js';
import { cdsEventsBus } from '../services/cds-events-bus.js';
import type { ContainerService } from '../services/container.js';
import type { ServerEventLogSink } from '../services/server-event-log-store.js';

// 与 pending-import 同款白名单 — 单独维护,免互相 import 路由
const NEEDS_CMD: Array<{ pattern: RegExp; example: string }> = [
  { pattern: /^minio\/minio/i, example: 'command: ["server", "/data", "--console-address", ":9001"]' },
  { pattern: /^(docker\.io\/library\/)?elasticsearch:/i, example: 'command: ["elasticsearch", "-Ediscovery.type=single-node"]' },
];

export interface InfraResyncDiff {
  adds: Array<{ id: string; name: string; dockerImage: string; containerPort: number }>;
  updates: Array<{ id: string; name: string; reasons: string[] }>;
  removes: Array<{ id: string; name: string; containerName: string; status: string }>;
  noChange: Array<{ id: string; name: string }>;
}

/**
 * 把 ComposeServiceDef 投影成"docker run 等价签名"用于 diff。
 * 排除会被 CDS 自动重算的字段(hostPort,容器名,timestamps 等)。
 */
function dockerRunSignature(svc: {
  dockerImage?: string;
  containerPort?: number;
  command?: string | string[];
  entrypoint?: string | string[];
  env?: Record<string, string>;
  volumes?: Array<{ name: string; containerPath: string; type?: string; readOnly?: boolean }>;
  restartPolicy?: string;
}): Record<string, unknown> {
  const sortedEnv = svc.env
    ? Object.fromEntries(Object.entries(svc.env).sort(([a], [b]) => a.localeCompare(b)))
    : {};
  const sortedVolumes = (svc.volumes || [])
    .map((v) => ({ name: v.name, containerPath: v.containerPath, type: v.type ?? 'volume', readOnly: !!v.readOnly }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    image: svc.dockerImage || '',
    port: svc.containerPort || 0,
    command: Array.isArray(svc.command) ? svc.command.join(' ') : svc.command || '',
    entrypoint: Array.isArray(svc.entrypoint) ? svc.entrypoint.join(' ') : svc.entrypoint || '',
    env: sortedEnv,
    volumes: sortedVolumes,
    restartPolicy: svc.restartPolicy || 'on-failure:3',
  };
}

/**
 * 比对 current InfraService 和 yaml ComposeServiceDef,
 * 返回变化的 reason 列表(空 = 完全一致)。
 */
function diffSignatures(
  current: InfraService,
  yamlSvc: {
    dockerImage: string;
    containerPort: number;
    command?: string | string[];
    entrypoint?: string | string[];
    env?: Record<string, string>;
    volumes?: Array<{ name: string; containerPath: string; type?: string; readOnly?: boolean }>;
  },
): string[] {
  const a = dockerRunSignature(current);
  const b = dockerRunSignature({ ...yamlSvc, restartPolicy: current.restartPolicy });
  const reasons: string[] = [];
  if (a.image !== b.image) reasons.push(`image: ${a.image} → ${b.image}`);
  if (a.port !== b.port) reasons.push(`port: ${a.port} → ${b.port}`);
  if (a.command !== b.command) reasons.push(`command: "${a.command}" → "${b.command}"`);
  if (a.entrypoint !== b.entrypoint) reasons.push(`entrypoint: "${a.entrypoint}" → "${b.entrypoint}"`);
  if (JSON.stringify(a.env) !== JSON.stringify(b.env)) reasons.push('env 有变化');
  if (JSON.stringify(a.volumes) !== JSON.stringify(b.volumes)) reasons.push('volumes 有变化');
  return reasons;
}

/**
 * 校验 infra 服务的 cmd 白名单。返回 null 即通过,否则错误消息。
 */
export function validateInfraCmds(infraServices: Array<{ id: string; dockerImage: string; command?: string | string[] }>): string | null {
  const bad = infraServices.filter((s) => {
    const match = NEEDS_CMD.find((r) => r.pattern.test(s.dockerImage));
    if (!match) return false;
    const cmdEmpty = s.command === undefined
      || (typeof s.command === 'string' && !s.command.trim())
      || (Array.isArray(s.command) && s.command.length === 0);
    return cmdEmpty;
  });
  if (bad.length === 0) return null;
  return bad.map((s) => {
    const example = NEEDS_CMD.find((r) => r.pattern.test(s.dockerImage))?.example || 'command: ["<start subcommand>"]';
    return `${s.id} (${s.dockerImage}) → ${example}`;
  }).join('; ');
}

export interface InfraResyncDeps {
  stateService: StateService;
  containerService: ContainerService;
  serverEventLogStore?: ServerEventLogSink | null;
  config: { portStart?: number; repoRoot: string };
  assertProjectAccess: (req: any, projectId: string) => { status: number; body: unknown } | null;
}

export function createProjectInfraResyncRouter(deps: InfraResyncDeps): Router {
  const router = Router();
  const { stateService, containerService, serverEventLogStore, config } = deps;

  function computeDiff(projectId: string, yamlText: string): {
    diff?: InfraResyncDiff;
    error?: { status: number; message: string; cmdValidationError?: string };
  } {
    let parsed;
    try {
      parsed = parseCdsCompose(yamlText);
    } catch (err) {
      return { error: { status: 400, message: `yaml 解析失败: ${(err as Error).message}` } };
    }
    if (!parsed) {
      return { error: { status: 400, message: 'yaml 不是合法的 CDS compose 文件(缺 x-cds-* 扩展或 app/infra services)' } };
    }
    const cmdErr = validateInfraCmds(parsed.infraServices);
    if (cmdErr) {
      return { error: { status: 400, message: '部分 infra 缺 command:', cmdValidationError: cmdErr } };
    }

    const currentInfra = stateService.getInfraServicesForProject(projectId);
    const currentById = new Map(currentInfra.map((s) => [s.id, s]));
    const yamlById = new Map((parsed.infraServices || []).map((s) => [s.id, s]));

    const diff: InfraResyncDiff = { adds: [], updates: [], removes: [], noChange: [] };

    for (const [id, yamlSvc] of yamlById) {
      const current = currentById.get(id);
      if (!current) {
        diff.adds.push({
          id,
          name: yamlSvc.name || id,
          dockerImage: yamlSvc.dockerImage,
          containerPort: yamlSvc.containerPort,
        });
      } else {
        const reasons = diffSignatures(current, yamlSvc);
        if (reasons.length === 0) {
          diff.noChange.push({ id, name: current.name });
        } else {
          diff.updates.push({ id, name: current.name, reasons });
        }
      }
    }
    for (const [id, current] of currentById) {
      if (!yamlById.has(id)) {
        diff.removes.push({
          id,
          name: current.name,
          containerName: current.containerName,
          status: current.status,
        });
      }
    }
    return { diff };
  }

  // GET 列出可用 yaml 来源:① 项目根目录的 cds-compose.yml(默认)
  // ② 最近 3 条已审批 PendingImport ③ 上传(前端自己处理,这里不返回)
  router.get('/projects/:id/infra/resync/sources', (req, res) => {
    const projectId = req.params.id;
    const access = deps.assertProjectAccess(req, projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    const project = stateService.getProject(projectId);
    if (!project) { res.status(404).json({ error: '项目不存在' }); return; }

    // 来源 1:项目根目录
    let repoCompose: { found: boolean; fileName?: string; yaml?: string; error?: string } = { found: false };
    try {
      const repoRoot = stateService.getProjectRepoRoot(projectId, config.repoRoot);
      const files = discoverComposeFiles(repoRoot);
      if (files.length > 0) {
        const yaml = nodeFs.readFileSync(files[0], 'utf-8');
        repoCompose = { found: true, fileName: nodePath.basename(files[0]), yaml };
      }
    } catch (err) {
      repoCompose = { found: false, error: (err as Error).message };
    }

    // 来源 2:最近 3 条已审批的 pending-import(本项目)
    const recentApproved = stateService.getPendingImports()
      .filter((i) => i.projectId === projectId && i.status === 'approved' && i.composeYaml)
      .sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || ''))
      .slice(0, 3)
      .map((i) => ({
        importId: i.id,
        agentName: i.agentName,
        decidedAt: i.decidedAt,
        yaml: i.composeYaml,
      }));

    res.json({ repoCompose, recentApproved });
  });

  router.post('/projects/:id/infra/resync/preview', (req, res) => {
    const projectId = req.params.id;
    const access = deps.assertProjectAccess(req, projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    const project = stateService.getProject(projectId);
    if (!project) { res.status(404).json({ error: '项目不存在' }); return; }

    const { composeYaml } = (req.body || {}) as { composeYaml?: string };
    if (!composeYaml || !composeYaml.trim()) {
      res.status(400).json({ error: 'composeYaml 必填' });
      return;
    }
    const { diff, error } = computeDiff(projectId, composeYaml);
    if (error) {
      res.status(error.status).json({ error: error.message, cmdValidationError: error.cmdValidationError });
      return;
    }
    res.json(diff);
  });

  router.post('/projects/:id/infra/resync/execute', async (req, res) => {
    const projectId = req.params.id;
    const access = deps.assertProjectAccess(req, projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    const project = stateService.getProject(projectId);
    if (!project) { res.status(404).json({ error: '项目不存在' }); return; }

    const { composeYaml, confirmText, deleteVolumes } = (req.body || {}) as { composeYaml?: string; confirmText?: string; deleteVolumes?: boolean };
    if (!composeYaml || !composeYaml.trim()) {
      res.status(400).json({ error: 'composeYaml 必填' });
      return;
    }
    const { diff, error } = computeDiff(projectId, composeYaml);
    if (error) {
      res.status(error.status).json({ error: error.message, cmdValidationError: error.cmdValidationError });
      return;
    }
    if (!diff) { res.status(500).json({ error: '内部:diff 为空' }); return; }

    // 有 removes 时强制 confirmText
    if (diff.removes.length > 0 && (confirmText || '').trim().toLowerCase() !== 'yes') {
      res.status(400).json({
        error: '此操作将删除 infra,必须传 confirmText="yes" 确认',
        removes: diff.removes,
      });
      return;
    }

    serverEventLogStore?.record({
      category: 'system',
      severity: 'warn',
      source: 'project-infra-resync',
      action: 'infra.resync.start',
      message: `开始重新同步项目 ${projectId} 的基础设施 (add=${diff.adds.length} update=${diff.updates.length} remove=${diff.removes.length})`,
      projectId,
      details: {
        adds: diff.adds.map((a) => a.id),
        updates: diff.updates.map((u) => ({ id: u.id, reasons: u.reasons })),
        removes: diff.removes.map((r) => r.id),
      },
    });

    // 重新解析以拿原始 def
    const parsed = parseCdsCompose(composeYaml);
    const yamlById = new Map((parsed?.infraServices || []).map((s) => [s.id, s]));

    const applied = { added: [] as string[], updated: [] as string[], removed: [] as string[] };
    const errors: Array<{ phase: string; id: string; message: string }> = [];

    // Phase 1: removes — 停 + 删容器 + 删 state(默认数据卷保留;
    // deleteVolumes=true 时显式删 named volume,需用户弹窗勾选过)
    const volumeRemovals: Array<{ name: string; ok: boolean; error?: string }> = [];
    for (const r of diff.removes) {
      try {
        const current = stateService.getInfraServiceForProjectAndId(projectId, r.id);
        try { await containerService.stopInfraService(r.containerName); } catch { /* tolerate */ }
        if (deleteVolumes && current) {
          const namedVols = (current.volumes || [])
            .filter((v) => v.type !== 'bind')
            .map((v) => v.name);
          if (namedVols.length > 0) {
            const vr = await containerService.removeNamedVolumes(namedVols);
            volumeRemovals.push(...vr);
          }
        }
        stateService.removeInfraService(r.id, projectId);
        applied.removed.push(r.id);
      } catch (err) {
        errors.push({ phase: 'remove', id: r.id, message: (err as Error).message });
      }
    }

    // Phase 2: updates — 停 + 删旧容器(同名 volume 不动)+ 用新签名重建 state + start
    for (const u of diff.updates) {
      try {
        const current = stateService.getInfraServiceForProjectAndId(projectId, u.id);
        const yamlSvc = yamlById.get(u.id);
        if (!current || !yamlSvc) continue;
        try { await containerService.stopInfraService(current.containerName); } catch { /* tolerate */ }
        // 更新字段:image/cmd/entrypoint/env/volumes/port,保留 hostPort + containerName
        stateService.updateInfraService(u.id, {
          dockerImage: yamlSvc.dockerImage,
          containerPort: yamlSvc.containerPort,
          env: yamlSvc.env || {},
          volumes: yamlSvc.volumes || [],
          healthCheck: yamlSvc.healthCheck,
          ...(yamlSvc.command !== undefined ? { command: yamlSvc.command } : { command: undefined }),
          ...(yamlSvc.entrypoint !== undefined ? { entrypoint: yamlSvc.entrypoint } : { entrypoint: undefined }),
          status: 'stopped',
          errorMessage: undefined,
        }, projectId);
        const refreshed = stateService.getInfraServiceForProjectAndId(projectId, u.id);
        if (refreshed) {
          try {
            await containerService.startInfraService(refreshed, stateService.getCustomEnv(projectId));
            stateService.updateInfraService(u.id, { status: 'running', errorMessage: undefined }, projectId);
          } catch (startErr) {
            stateService.updateInfraService(u.id, { status: 'error', errorMessage: (startErr as Error).message }, projectId);
            errors.push({ phase: 'update.start', id: u.id, message: (startErr as Error).message });
          }
        }
        applied.updated.push(u.id);
      } catch (err) {
        errors.push({ phase: 'update', id: u.id, message: (err as Error).message });
      }
    }

    // Phase 3: adds — 标准 addInfraService 路径
    for (const a of diff.adds) {
      try {
        const yamlSvc = yamlById.get(a.id);
        if (!yamlSvc) continue;
        const containerName = project.legacyFlag
          ? `cds-infra-${yamlSvc.id}`
          : `cds-infra-${(project.slug || projectId).slice(0, 12)}-${yamlSvc.id}`;
        const service: InfraService = {
          id: yamlSvc.id,
          projectId,
          name: yamlSvc.name || yamlSvc.id,
          dockerImage: yamlSvc.dockerImage,
          containerPort: yamlSvc.containerPort,
          hostPort: stateService.allocatePort(config.portStart || 10000),
          containerName,
          status: 'stopped',
          volumes: yamlSvc.volumes || [],
          env: yamlSvc.env || {},
          healthCheck: yamlSvc.healthCheck,
          ...(yamlSvc.command !== undefined ? { command: yamlSvc.command } : {}),
          ...(yamlSvc.entrypoint !== undefined ? { entrypoint: yamlSvc.entrypoint } : {}),
          createdAt: new Date().toISOString(),
        };
        stateService.addInfraService(service);
        try {
          await containerService.startInfraService(service, stateService.getCustomEnv(projectId));
          stateService.updateInfraService(service.id, { status: 'running', errorMessage: undefined }, projectId);
        } catch (startErr) {
          stateService.updateInfraService(service.id, { status: 'error', errorMessage: (startErr as Error).message }, projectId);
          errors.push({ phase: 'add.start', id: service.id, message: (startErr as Error).message });
        }
        applied.added.push(service.id);
      } catch (err) {
        errors.push({ phase: 'add', id: a.id, message: (err as Error).message });
      }
    }

    stateService.save();

    serverEventLogStore?.record({
      category: 'system',
      severity: errors.length > 0 ? 'warn' : 'info',
      source: 'project-infra-resync',
      action: 'infra.resync.done',
      message: `项目 ${projectId} 基础设施同步完成 (added=${applied.added.length} updated=${applied.updated.length} removed=${applied.removed.length} errors=${errors.length})`,
      projectId,
      details: { applied, errors },
    });
    try {
      cdsEventsBus.publish('pending-import.count', { pendingCount: stateService.getPendingImports().filter((i) => i.status === 'pending').length });
    } catch { /* ignore */ }

    res.json({ applied, errors, volumeRemovals });
  });

  return router;
}
