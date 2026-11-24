import {planFreshCatalogInfra,assertFreshLegacyVolumesAbsent,type FreshInfraPlan} from '../services/fresh-catalog-storage-plan.js';
import { projectResourceNamespace } from '../services/preview-slug.js';
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
import type { InfraService, IShellExecutor } from '../types.js';
import {randomUUID} from 'node:crypto';
import {load as loadYaml} from 'js-yaml';
import {StorageProvisionService,storageProvisionDigest} from '../services/storage-provision.js';
import {infraStoragePlan,stableStorageVolumeName} from '../services/deployment-storage-plan.js';
import {assertInfraStorageBoundary} from '../services/deployment-storage-boundary.js';
import {recommendedVolumePathsFromCatalog} from '../services/infra-catalog.js';
import {assertInfraAuthenticationConfigured} from '../services/infra-auth-policy.js';
import { parseCdsCompose, discoverComposeFiles, resolveEnvTemplates, resolveCommandTemplate } from '../services/compose-parser.js';
import { cdsEventsBus } from '../services/cds-events-bus.js';
import type { ContainerService } from '../services/container.js';
import type { ServerEventLogSink } from '../services/server-event-log-store.js';
import { findInfraCmdViolations } from '../config/infra-cmd-whitelist.js';
import { sanitizeDockerRestartPolicy } from '../config/docker-restart-policy.js';

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
    restartPolicy?: string;
  },
): string[] {
  const a = dockerRunSignature(current);
  // Cursor Bugbot(PR #684):此前硬编码 `restartPolicy: current.restartPolicy`,
  // 让两侧 restartPolicy 永远相等 → 文件头(第 11 行)声称 restartPolicy 是
  // 重建触发条件却永远检测不到。根因是 yaml 解析以前不产出 restartPolicy,
  // 直接删覆盖会让每个非默认 restartPolicy 的服务都报假 diff。现在 parseCdsCompose
  // 已从 yaml 的 `restart:` 读出 restartPolicy:yaml 显式声明时用它比对,未声明
  // 则沿用 current(保留原"不写就不报假 diff"的初衷,同时尊重显式声明)。
  const b = dockerRunSignature({
    ...yamlSvc,
    restartPolicy: yamlSvc.restartPolicy ?? current.restartPolicy,
  });
  const reasons: string[] = [];
  if (a.image !== b.image) reasons.push(`image: ${a.image} → ${b.image}`);
  if (a.port !== b.port) reasons.push(`port: ${a.port} → ${b.port}`);
  if (a.command !== b.command) reasons.push(`command: "${a.command}" → "${b.command}"`);
  if (a.entrypoint !== b.entrypoint) reasons.push(`entrypoint: "${a.entrypoint}" → "${b.entrypoint}"`);
  if (JSON.stringify(a.env) !== JSON.stringify(b.env)) reasons.push('env 有变化');
  if (JSON.stringify(a.volumes) !== JSON.stringify(b.volumes)) reasons.push('volumes 有变化');
  if (a.restartPolicy !== b.restartPolicy) reasons.push(`restartPolicy: ${a.restartPolicy} → ${b.restartPolicy}`);
  return reasons;
}

/**
 * 校验 infra 服务的 cmd 白名单。返回 null 即通过,否则错误消息。
 * 白名单走 config/infra-cmd-whitelist.ts 的 SSOT(与 pending-import 共用)。
 */
export function validateInfraCmds(infraServices: Array<{ id: string; dockerImage: string; command?: string | string[] }>): string | null {
  const violations = findInfraCmdViolations(infraServices);
  if (violations.length === 0) return null;
  return violations.map((v) => `${v.id} (${v.dockerImage}) → ${v.example}`).join('; ');
}

export interface InfraResyncDeps {
  stateService: StateService;
  containerService: ContainerService;
  serverEventLogStore?: ServerEventLogSink | null;
  shell?: IShellExecutor;
  config: { portStart?: number; repoRoot: string; storageInstanceId?: string };
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
    if (!project) { res.status(404).json({error:'项目不存在'}); return; }
    const {composeYaml, confirmText, deleteVolumes, initializeStorage} = req.body || {};
    if (typeof composeYaml !== 'string' || !composeYaml.trim()
      || initializeStorage !== undefined && initializeStorage !== 'new-only') {
      res.status(400).json({error:'storage_provision_input_invalid'}); return;
    }
    const {diff, error} = computeDiff(projectId, composeYaml);
    if (error) { res.status(error.status).json({error:error.message,cmdValidationError:error.cmdValidationError}); return; }
    if (!diff) { res.status(500).json({error:'内部:diff 为空'}); return; }
    if (diff.removes.length && (typeof confirmText !== 'string' || confirmText.trim().toLowerCase() !== 'yes')) {
      res.status(400).json({error:'此操作将删除 infra,必须传 confirmText="yes" 确认',removes:diff.removes}); return;
    }
    const applied = {added:[] as string[],updated:[] as string[],removed:[] as string[]};
    const allocated:string[]=[];
    const errors:Array<{phase:string;id:string;message:string}>=[];
    const volumeRemovals:Array<{name:string;ok:boolean;error?:string}>=[];
    const reject=()=>new Error('storage_resync_unconfirmed');
    const configuredEnv=structuredClone(stateService.getCustomEnv(projectId));
    const projectDigest=storageProvisionDigest(project);
    const configDigest=storageProvisionDigest(config);
    const expected=new Map(stateService.getInfraServicesForProject(projectId).map(s=>[s.id,{ref:s,digest:storageProvisionDigest(s)}]));
    const acceptOwnWrite=(id:string)=>{
      const current=stateService.getInfraServiceForProjectAndId(projectId,id);
      if(current)expected.set(id,{ref:current,digest:storageProvisionDigest(current)});else expected.delete(id);
    };
    const fence=()=>{
      if(stateService.getProject(projectId)!==project || project.paused || projectDigest!==storageProvisionDigest(project)
        || configDigest!==storageProvisionDigest(config) || deps.assertProjectAccess(req,projectId)
        || storageProvisionDigest(stateService.getCustomEnv(projectId))!==storageProvisionDigest(configuredEnv))throw reject();
      const current=stateService.getInfraServicesForProject(projectId);
      if(current.length!==expected.size || current.some(s=>expected.get(s.id)?.ref!==s || expected.get(s.id)?.digest!==storageProvisionDigest(s)))throw reject();
    };
    try {
      fence();
      // ALL removals are checked before any new allocation, update or runtime action.
      for (const change of diff.removes) stateService.assertInfraRemovalAllowed(change.id, projectId);
      const parsed=parseCdsCompose(composeYaml)!;
      const definitions=new Map(parsed.infraServices.map(s=>[s.id,s]));
      const raw=(loadYaml(composeYaml) as any)?.services || {};
      // A relative bind must not silently reclassify an old DB as an app/removal.
      if(diff.removes.some(r=>Object.hasOwn(raw,r.id)))throw reject();
      const reserved=new Set<number>();
      const preparedUpdates=new Map<string,InfraService>();
      const preparedAdds=new Map<string,{service:InfraService;provision:boolean}>();
      const freshPlans:FreshInfraPlan[]=[];
      const authenticate=(service:InfraService)=>assertInfraAuthenticationConfigured({...service,
        env:resolveEnvTemplates(service.env,configuredEnv),command:resolveCommandTemplate(service.command,configuredEnv),
        entrypoint:resolveCommandTemplate(service.entrypoint,configuredEnv)});
      // First pass is pure for the ENTIRE graph; no Docker, State mutation or birth.
      for(const change of [...diff.updates,...diff.adds]) {
        const def=definitions.get(change.id);if(!def)throw reject();
        const old=expected.get(change.id)?.ref;
        const service:InfraService={...(old?structuredClone(old):{
          id:def.id,projectId,name:def.name||def.id,hostPort:stateService.allocatePort(config.portStart||10000,reserved),
          containerName:project.legacyFlag?`cds-infra-${def.id}`:`cds-infra-${projectResourceNamespace(project).slice(0,12)}-${def.id}`,
          createdAt:new Date().toISOString(),
        }),dockerImage:def.dockerImage,containerPort:def.containerPort,env:structuredClone(def.env||{}),volumes:structuredClone(def.volumes||[]),
          healthCheck:structuredClone(def.healthCheck),command:structuredClone(def.command),entrypoint:structuredClone(def.entrypoint),
          ...(def.restartPolicy!==undefined?{restartPolicy:sanitizeDockerRestartPolicy(def.restartPolicy)}:{}),status:'stopped',errorMessage:undefined};
        if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(service.containerName)
          || !Number.isInteger(service.containerPort) || service.containerPort<1 || service.containerPort>65535
          || !Number.isInteger(service.hostPort) || service.hostPort<1 || service.hostPort>65535)throw reject();
        reserved.add(service.hostPort);
        let provision=false;
        if(Object.hasOwn(raw[def.id]||{},'volumes') && !Array.isArray(raw[def.id].volumes))throw reject();
        if(!old) {
          if(stateService.getStorageBirthsForService(projectId,service.id).length)throw reject();
          const planned=planFreshCatalogInfra(service,config,initializeStorage==='new-only');
          if(planned.provision&&!deps.shell)throw reject();
          Object.assign(service,planned.service);provision=planned.provision;freshPlans.push(planned);
        } else if(Object.hasOwn(raw[def.id]||{},'volumes') && !Array.isArray(raw[def.id].volumes))throw reject();
        if(old && storageProvisionDigest(old.volumes||[])!==storageProvisionDigest(service.volumes))throw reject();
        authenticate(service);assertInfraStorageBoundary(service,config);infraStoragePlan(service,config);
        if(old)preparedUpdates.set(service.id,service);else preparedAdds.set(service.id,{service,provision});
      }
      // ALL replacements are admitted strictly before the first remove/stop.
      for(const [id,service] of preparedUpdates) {
        preparedUpdates.set(id,await containerService.preflightInfraStorage(service,{assertCurrent:fence}));fence();
      }
      for(const [id,add] of preparedAdds) {
        if(!add.provision){add.service=await containerService.preflightInfraStorage(add.service,{assertCurrent:fence});fence();}
      }
      await assertFreshLegacyVolumesAbsent(freshPlans,deps.shell!,fence);
      // Explicit fresh P finishes and ACKs before any destructive phase. Failures keep original births.
      for(const [id,add] of preparedAdds) {
        if(!add.provision)continue;
        const frozen=storageProvisionDigest(add.service);
        await new StorageProvisionService(stateService,deps.shell!,config).provisionNewInfra(add.service,infraStoragePlan(add.service,config),`storage_${randomUUID()}`,fence);
        const published=stateService.getInfraServiceForProjectAndId(projectId,id);
        if(!published || storageProvisionDigest(published)!==frozen)throw reject();
        acceptOwnWrite(id);fence();allocated.push(id);
        add.service=await containerService.preflightInfraStorage(add.service,{assertCurrent:fence});fence();
      }
      fence();
      serverEventLogStore?.record({category:'system',severity:'warn',source:'project-infra-resync',action:'infra.resync.start',
        message:`开始重新同步项目 ${projectId} 的基础设施`,projectId,
        details:{adds:diff.adds.map(s=>s.id),updates:diff.updates.map(s=>s.id),removes:diff.removes.map(s=>s.id)}});
      for(const r of diff.removes) {
        fence();const current=expected.get(r.id)!.ref;
        await containerService.stopInfraService(current.containerName,'cds-infra-remove');fence();
        if(deleteVolumes){const names=(current.volumes||[]).filter(v=>v.type!=='bind').map(v=>v.name);
          if(names.length){volumeRemovals.push(...await containerService.removeNamedVolumes(names));fence();}}
        stateService.removeInfraService(r.id,projectId);acceptOwnWrite(r.id);applied.removed.push(r.id);
      }
      for(const [id,accepted] of preparedUpdates) {
        fence();await containerService.stopInfraService(accepted.containerName);fence();
        // State and runtime consume the SAME frozen declaration, not newly resolved mutable inputs.
        stateService.updateInfraService(id,structuredClone(accepted),projectId);acceptOwnWrite(id);
        await containerService.startInfraService(accepted,configuredEnv);fence();
        stateService.updateInfraService(id,{status:'running',errorMessage:undefined},projectId);acceptOwnWrite(id);applied.updated.push(id);
      }
      for(const [id,add] of preparedAdds) {
        fence();if(!add.provision){stateService.addInfraService(structuredClone(add.service));acceptOwnWrite(id);}
        await containerService.startInfraService(add.service,configuredEnv);fence();
        stateService.updateInfraService(id,{status:'running',errorMessage:undefined},projectId);acceptOwnWrite(id);applied.added.push(id);
      }
      stateService.save();await stateService.flush();fence();
      serverEventLogStore?.record({category:'system',severity:'info',source:'project-infra-resync',action:'infra.resync.done',
        message:`项目 ${projectId} 基础设施同步完成`,projectId,details:{applied,errors}});
      try{cdsEventsBus.publish('pending-import.count',{pendingCount:stateService.getPendingImports().filter(i=>i.status==='pending').length});}catch{/* observer only */}
      res.json({applied,errors,volumeRemovals,allocated});
    } catch (error) {
      if ((error as Error).message.startsWith('storage_retained_service_delete_refused:')) { res.status(409).json({error:'storage_retained_service_delete_refused',message:(error as Error).message,applied,allocated}); return; }
      // No retry/reallocation/rollback guesses. A confirmed or uncertain P remains held for reconciliation.
      res.status(409).json({error:'storage_resync_unconfirmed',applied,allocated,recoveryRequired:true});
    }
  });

  return router;
}
