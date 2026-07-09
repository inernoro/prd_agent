// 项目虚拟 cds-compose.yml 路由 (2026-05-29)
//
// 用户诉求(本次讨论 + feature-emerge 第一波 E1+E2):
//   "每个 project 应该维护一个虚拟的 cds-compose.yml 文件, 用户可以通过项目的
//    agent 去通过技能动态的更改这个 cds-compose.yml, 也可以下载更新本地的 cds 文件"
//
// 本路由把虚拟 compose 提升为 Project 一等公民的读写入口:
//
//   GET  /api/projects/:id/compose.yml
//     → text/yaml 纯文本下载(浏览器/agent 都能直接拿)。无 composeYaml 的老
//       项目走 fallback:从已落库 build profile + infra 反向拼一份只读视图。
//
//   GET  /api/projects/:id/compose
//     → JSON { yaml, version, updatedAt, source, hasPersisted, authority[] }
//       authority[] 是三级权威标注(repo/platform/user),供面板渲染图例 +
//       技能预览"我能改哪些字段"。
//
//   PUT  /api/projects/:id/compose
//     body: { yaml: string, actor?: 'agent'|'user', source?: ... }
//     → 先 parseCdsCompose 校验可解析,再跑 validateComposePatch 权威校验
//       (platform 字段被改一律 reject),通过后 setProjectCompose 落库 + 广播
//       project.config.changed 事件。
//       注意:本接口**只更新虚拟 compose 文本**,不直接重建容器 —— 真正应用
//       走既有的 infra resync(POST .../infra/resync/execute),职责分离。

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';
import type { StateService } from '../services/state.js';
import type { BuildProfile, InfraService, PendingImport } from '../types.js';
import { parseCdsCompose } from '../services/compose-parser.js';
import { annotateComposeAuthority, validateComposePatch, classifyComposeField, escapeSeg } from '../services/config-authority.js';
import { computeComposeDrift, type LiveComposeSnapshot } from '../services/compose-drift.js';
import { cdsEventsBus } from '../services/cds-events-bus.js';

/** 解析原始 cds-compose YAML 拿到 services map(权威标注/字段 diff 用)。 */
function parseRawServices(yamlText: string): { services?: Record<string, Record<string, unknown>> } | null {
  try {
    const doc = yaml.load(yamlText) as any;
    if (!doc || typeof doc !== 'object') return null;
    return { services: doc.services };
  } catch {
    return null;
  }
}

export interface ProjectComposeDeps {
  stateService: StateService;
  assertProjectAccess: (req: any, projectId: string) => { status: number; body: unknown } | null;
  /** 全局 repoRoot 兜底(legacy 项目无 per-project repoPath 时用)。 */
  repoRootFallback: string;
}

/** 从项目 worktree 读 repo 的 cds-compose.yml(结构种子)。缺失返回 null。 */
function readRepoComposeYaml(repoRoot: string): string | null {
  const candidates = [
    path.join(repoRoot, 'cds-compose.yaml'),
    path.join(repoRoot, 'cds-compose.yml'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch { /* try next */ }
  }
  return null;
}

/** 组装 CDS 侧现有配置树快照,喂给 computeComposeDrift(纯函数)。 */
function buildLiveSnapshot(stateService: StateService, projectId: string): LiveComposeSnapshot {
  const profiles = stateService.getBuildProfilesForProject(projectId) || [];
  const infra = stateService.getInfraServicesForProject(projectId) || [];
  const routes = stateService.getRoutingRulesForProject?.(projectId) || [];
  const profileCommands: Record<string, string | undefined> = {};
  for (const p of profiles) profileCommands[p.id] = p.command;
  return {
    buildProfileIds: profiles.map((p) => p.id),
    profileCommands,
    infraServiceIds: infra.map((s) => s.id),
    routingRuleIds: routes.map((r) => r.id),
    envKeys: Object.keys(stateService.getCustomEnv(projectId) || {}),
  };
}

/**
 * 老项目没有 composeYaml 时,从已落库的 build profile + infra 反向拼一份
 * 只读 cds-compose.yml 视图。不追求 round-trip 精确,目的是让用户「至少能
 * 看到 + 下载一份起点」,再编辑回写就有了真正的 SSOT。
 */
function synthesizeComposeFromState(
  stateService: StateService,
  projectId: string,
): string {
  const profiles = stateService.getBuildProfilesForProject?.(projectId)
    ?? (stateService as any).getBuildProfiles?.().filter((p: BuildProfile) => p.projectId === projectId)
    ?? [];
  const infra = stateService.getInfraServicesForProject(projectId) || [];
  const project = stateService.getProject(projectId);

  const lines: string[] = [];
  lines.push('# 由 CDS 从当前已落库的 build profile + infra 反向生成(只读起点)');
  lines.push('# 编辑后 PUT /api/projects/<id>/compose 即固化为项目配置 SSOT');
  lines.push(`x-cds-project:`);
  lines.push(`  name: ${project?.slug || projectId}`);
  lines.push('services:');
  for (const p of profiles as BuildProfile[]) {
    lines.push(`  ${p.id}:`);
    if (p.dockerImage) lines.push(`    image: ${p.dockerImage}`);
    if (p.workDir) lines.push(`    build:`);
    if (p.workDir) lines.push(`      workDir: ${p.workDir}`);
    if (p.command) lines.push(`    command: ${JSON.stringify(p.command)}`);
    if (p.containerPort) lines.push(`    ports: ["${p.containerPort}"]`);
  }
  for (const s of infra as InfraService[]) {
    lines.push(`  ${s.id}:`);
    if (s.dockerImage) lines.push(`    image: ${s.dockerImage}`);
    if (s.containerPort) lines.push(`    ports: ["${s.containerPort}"]`);
    if (s.volumes && s.volumes.length > 0) {
      const vols = s.volumes.map((v) => `${v.name}:${v.containerPath}`);
      lines.push(`    volumes: ${JSON.stringify(vols)}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function createProjectComposeRouter(deps: ProjectComposeDeps): Router {
  const router = Router();
  const { stateService } = deps;

  // GET .../compose.yml — 纯文本下载
  router.get('/projects/:id/compose.yml', (req, res) => {
    const projectId = req.params.id;
    const access = deps.assertProjectAccess(req, projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    const project = stateService.getProject(projectId);
    if (!project) { res.status(404).json({ error: '项目不存在' }); return; }

    const yaml = project.composeYaml || synthesizeComposeFromState(stateService, projectId);
    res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cds-compose.yml"`);
    res.send(yaml);
  });

  // GET .../compose — JSON(含三级权威标注)
  router.get('/projects/:id/compose', (req, res) => {
    const projectId = req.params.id;
    const access = deps.assertProjectAccess(req, projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    const project = stateService.getProject(projectId);
    if (!project) { res.status(404).json({ error: '项目不存在' }); return; }

    const hasPersisted = !!project.composeYaml;
    const yaml = project.composeYaml || synthesizeComposeFromState(stateService, projectId);
    const authority = annotateComposeAuthority(parseRawServices(yaml));

    res.json({
      yaml,
      hasPersisted,
      version: project.composeVersion ?? 0,
      updatedAt: project.composeUpdatedAt ?? null,
      source: project.composeSource ?? null,
      authority,
    });
  });

  // PUT .../compose — 回写虚拟 compose(权威校验)
  router.put('/projects/:id/compose', (req, res) => {
    const projectId = req.params.id;
    const access = deps.assertProjectAccess(req, projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    const project = stateService.getProject(projectId);
    if (!project) { res.status(404).json({ error: '项目不存在' }); return; }

    const { yaml, actor, source } = (req.body || {}) as {
      yaml?: string;
      actor?: 'agent' | 'user';
      source?: 'manual-edit' | 'repo-sync';
    };
    if (!yaml || typeof yaml !== 'string' || !yaml.trim()) {
      res.status(400).json({ error: 'yaml 不能为空' });
      return;
    }

    // 1) 必须可解析
    let parsedNew: any;
    try {
      parsedNew = parseCdsCompose(yaml);
    } catch (err) {
      res.status(400).json({ error: 'YAML 解析失败', detail: (err as Error).message });
      return;
    }
    if (!parsedNew) {
      res.status(400).json({ error: 'YAML 解析失败:无法识别 cds-compose 结构' });
      return;
    }

    // 2) 权威校验:对比旧 compose,找出被改动的字段,platform 字段禁止非平台调用方修改
    const callerActor: 'agent' | 'user' = actor === 'agent' ? 'agent' : 'user';
    // Codex review(PR #684):legacy 项目还没持久化 composeYaml 时,GET 返回的是
    // synthesizeComposeFromState 合成结果。若这里拿 undefined 当 diff 基线,首次
    // 保存会把合成 yaml 里**未改动**的平台字段(services.*.ports 等)也算成"新增
    // 改动",validateComposePatch 以 platform-owned 拒绝 user 调用方 → 用户只改了
    // 一个 repo/user 字段也存不进去,除非手动删掉必填端口。基线必须与 GET 对齐:
    // composeYaml 缺失时用同一份合成结果兜底,这样未改动的平台字段不进 changedPaths。
    const oldYaml = project.composeYaml || synthesizeComposeFromState(stateService, projectId);
    const changedPaths = diffChangedFieldPaths(oldYaml, yaml);
    const validation = validateComposePatch(changedPaths, callerActor);
    if (!validation.ok) {
      res.status(403).json({
        error: '配置权威校验未通过',
        message: '以下字段属于平台权威(端口/网络/域名由 CDS 管理),不可修改',
        violations: validation.violations,
      });
      return;
    }

    // 3) 落库 + 广播
    const newVersion = stateService.setProjectCompose(projectId, yaml, source === 'repo-sync' ? 'repo-sync' : 'manual-edit');
    // Cursor Bugbot(PR #684):setProjectCompose 只改内存,不内部持久化(对比
    // pending-import approve 路径显式调 save())。不 save 则进程崩溃前这次 compose
    // 写入会丢。显式持久化。
    stateService.save();
    try {
      cdsEventsBus.publish('project.config.changed', {
        projectId,
        composeVersion: newVersion,
        source: source === 'repo-sync' ? 'repo-sync' : 'manual-edit',
        actor: callerActor,
      });
    } catch { /* ignore */ }

    res.json({
      ok: true,
      version: newVersion,
      changedPaths,
      note: '已更新虚拟 cds-compose.yml。如需让容器生效,请走「重新同步」(infra resync)应用。',
    });
  });

  // POST .../compose-drift-scan — 波4 漂移巡检
  //
  // 从项目 worktree 读 repo 的 cds-compose.yml(结构种子),与 CDS 配置树 diff,
  // 按权威分级产出「同步建议」。repo→CDS 单向:
  //   - 有结构漂移且 body.createImport===true → 开一条 repo-sync PendingImport 走人审
  //     (复用既有 pending-import 审批流,人审 approve 后落 CDS 配置树)
  //   - 密钥/占位符键出现在 repo → 报「应剥离」违规(偿还 D1)
  //   - CDS 运行时独占的 env 键 → 标注「CDS 权威,不回写 repo」
  router.post('/projects/:id/compose-drift-scan', (req, res) => {
    const projectId = req.params.id;
    const access = deps.assertProjectAccess(req, projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    const project = stateService.getProject(projectId);
    if (!project) { res.status(404).json({ error: '项目不存在' }); return; }

    const repoRoot = stateService.getProjectRepoRoot(projectId, deps.repoRootFallback);
    const repoYaml = readRepoComposeYaml(repoRoot);
    let repoParsed = null;
    if (repoYaml) {
      try { repoParsed = parseCdsCompose(repoYaml); } catch { repoParsed = null; }
    }
    const live = buildLiveSnapshot(stateService, projectId);
    const report = computeComposeDrift(repoParsed, live);

    const createImport = (req.body || {}).createImport === true;
    let createdImportId: string | null = null;
    // 仅在有 repo compose、有结构漂移、且调用方要求时才开单 —— 不制造噪音。
    if (createImport && report.hasRepoCompose && report.syncRecommended && repoYaml) {
      // 去重:该项目已有 pending 的 repo-sync 单则不重复开。
      const dup = stateService
        .getPendingImports()
        .some((i) => i.projectId === projectId && i.status === 'pending' && i.agentName === REPO_SYNC_AGENT);
      if (!dup) {
        const item: PendingImport = {
          id: randomHex(),
          projectId,
          agentName: REPO_SYNC_AGENT,
          purpose: 'repo cds-compose.yml 结构漂移;人审后同步进 CDS 配置树(单向种子,不回写 repo)',
          composeYaml: repoYaml,
          summary: {
            addedProfiles: report.structuralDrift.addedProfiles,
            addedInfra: report.structuralDrift.addedInfra,
            addedEnvKeys: report.structuralDrift.addedStructuralEnvKeys,
          },
          submittedAt: new Date().toISOString(),
          status: 'pending',
        };
        stateService.addPendingImport(item);
        stateService.save();
        createdImportId = item.id;
        try {
          const pendingCount = stateService.getPendingImports().filter((i) => i.status === 'pending').length;
          cdsEventsBus.publish('pending-import.created', {
            importId: item.id,
            projectId,
            agentName: item.agentName,
            purpose: item.purpose,
            summary: item.summary,
            submittedAt: item.submittedAt,
            pendingCount,
          });
          cdsEventsBus.publish('pending-import.count', { pendingCount });
        } catch { /* event publish 失败不影响主流程 */ }
      }
    }

    res.json({
      projectId,
      report,
      createdImportId,
      approveUrl: createdImportId ? `/project-list?pendingImport=${createdImportId}` : null,
    });
  });

  return router;
}

/** repo-sync 漂移巡检开单时的固定 agentName(用于去重 + 面板标注来源)。 */
const REPO_SYNC_AGENT = 'repo-sync 漂移巡检';

/** 生成 pending-import 用的 16 字节 hex id(与 pending-import.ts 的 newId 同源规格)。 */
function randomHex(): string {
  return randomBytes(16).toString('hex');
}

/**
 * 把整份 compose 文档(含顶层键)递归展开成叶子路径集合,返回新增/改动的路径。
 * 用于权威校验「调用方动了哪些字段」。解析失败时保守返回空(上层 parse 已先校验)。
 *
 * Codex review(PR #684, P2×2):此前只读 `parsed.services` 且只展一层
 * (`services.{svc}.{field}`),导致两类 platform 字段绕过权威校验:
 *   1. 顶层平台键 networks / x-cds-domain —— 压根没进 map
 *   2. 嵌套平台叶子 services.*.deploy.replicas —— 只记到 services.{svc}.deploy
 *      (归一成 services.*.deploy,表里没有 → 被当 user 放行)
 * 改为:解析**整份文档**(不止 services)+ 递归到叶子。配合 classifyComposeField
 * 的祖先匹配,任何 platform 子树下的改动都会被正确识别。
 */
function flattenDocToLeaves(value: unknown, prefix: string, map: Map<string, string>): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      // 空对象本身也是一个可比较的叶子(从有内容变空 = 改动)
      map.set(prefix, '{}');
      return;
    }
    for (const [k, v] of entries) {
      // escapeSeg:object key(尤其 service 名)可能含 `.`,转义后 classifyComposeField
      // 的 splitPath 才能把它当成单段,不误切(Codex review PR #684)。
      const seg = escapeSeg(k);
      flattenDocToLeaves(v, prefix ? `${prefix}.${seg}` : seg, map);
    }
    return;
  }
  // 原始值 / 数组 → 叶子(数组整体作为一个值比较,如 ports 列表)
  map.set(prefix, JSON.stringify(value));
}

function diffChangedFieldPaths(oldYaml: string | undefined, newYaml: string): string[] {
  const flatten = (yamlText: string | undefined): Map<string, string> => {
    const map = new Map<string, string>();
    if (!yamlText) return map;
    let doc: unknown;
    try { doc = yaml.load(yamlText); } catch { return map; }
    if (!doc || typeof doc !== 'object') return map;
    flattenDocToLeaves(doc, '', map);
    return map;
  };
  const oldMap = flatten(oldYaml);
  const newMap = flatten(newYaml);
  const changed: string[] = [];
  for (const [path, val] of newMap) {
    if (oldMap.get(path) !== val) changed.push(path);
  }
  // 旧有新无 = 删除,也算改动
  for (const path of oldMap.keys()) {
    if (!newMap.has(path)) changed.push(path);
  }
  return changed;
}

// re-export 供测试直接引用
export { classifyComposeField };
