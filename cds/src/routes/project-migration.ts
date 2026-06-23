/**
 * 项目迁移路由（项目级，2026-06-23）
 *
 * 用户诉求:"以前 CDS 有一键导出、可被其他平台复刻部署的配置功能,现在不见了。
 * 在项目设置里加回一个『迁移』入口,把当前 CDS 项目移植到另一个 CDS 节点
 * (例如 noroenrn.com)。包括配置打包复刻 + 数据迁移。"
 *
 * 背景: `CdsPeer` / `DataMigration` 类型、state CRUD、server.ts 的 /data-migrations
 * API label 都还在,但路由处理器文件早已丢失,前端 UI 也没了 —— 这正是用户记得
 * 的"消失的功能"。本路由在既有底座上把它补回来,并明确做成**项目级移植**。
 *
 * 端点(全部 `/api/projects/:id/migration/*`,项目级,scope-naming.md §3):
 *   GET    /projects/:id/migration/peers              列出迁移目标(远端 CDS 节点)
 *   POST   /projects/:id/migration/peers              新增迁移目标 {name, baseUrl, accessKey?}
 *   POST   /projects/:id/migration/peers/:peerId/verify  连接测试(真实打远端 /api/me)
 *   DELETE /projects/:id/migration/peers/:peerId      删除迁移目标
 *   GET    /projects/:id/migration/config-preview     预览本项目可复刻的 cds-compose 配置
 *   POST   /projects/:id/migration/replicate-config   把配置推到远端 CDS 复刻部署(支持 dryRun)
 *   POST   /projects/:id/migration/data-plan          数据迁移扫描(只读:源库 + 目标可达性)
 *
 * 安全:
 *   - 远端鉴权用目标节点自己的 accessKey;未填则回退本机 AI_ACCESS_KEY
 *     (同一套密钥跨节点通用的场景,用户已确认)。
 *   - accessKey 明文不出库到前端,只回 hasKey 布尔 + 掩码。
 *   - 配置复刻默认 dryRun 预演;数据迁移本路由只做**只读扫描**,真正的全量
 *     落库走既有、已测的 /api/infra/:id/backup → 远端 /api/infra/:id/restore
 *     原语(见 data-plan 返回的 manualBridge),避免新增未经验证的破坏性代码。
 */

import { Router } from 'express';

import type { StateService } from '../services/state.js';
import type { BuildProfile, CdsPeer, InfraService, RoutingRule } from '../types.js';
import { toCdsCompose } from '../services/compose-parser.js';
import { getCdsAiAccessKey } from '../config/known-env-keys.js';

export interface ProjectMigrationDeps {
  stateService: StateService;
  /** 项目作用域守卫:项目级 key 越权访问别的项目时返回 403,admin/cookie 为 no-op。 */
  assertProjectAccess: (req: any, projectId: string) => { status: number; body: unknown } | null;
  /** CDS 鉴权模式。disabled(开放面板)时没有 cookie/session 标记且本就无安全边界,迁移放行。 */
  authMode: 'disabled' | 'basic' | 'github';
}

/** 对外视图:绝不回明文 accessKey,只给掩码 + hasKey。 */
interface PeerPublicView {
  id: string;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  keyMasked: string | null;
  createdAt: string;
  lastVerifiedAt?: string;
  remoteLabel?: string;
}

export function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-2)}`;
}

export function toPublicView(peer: CdsPeer): PeerPublicView {
  return {
    id: peer.id,
    name: peer.name,
    baseUrl: peer.baseUrl,
    hasKey: !!peer.accessKey,
    keyMasked: maskKey(peer.accessKey),
    createdAt: peer.createdAt,
    lastVerifiedAt: peer.lastVerifiedAt,
    remoteLabel: peer.remoteLabel,
  };
}

/** 去掉尾部斜杠,补全协议(默认 https)。 */
export function normalizeBaseUrl(raw: string): string {
  let url = String(raw || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

/** 解析对该 peer 鉴权要用的 key:优先 peer 自带,回退本机 key(process.env + Dashboard 全局变量)。 */
function resolvePeerKey(peer: CdsPeer, fallbackKey: string | undefined): string | undefined {
  return peer.accessKey || fallbackKey;
}

/** 带超时的远端 CDS 请求,自动附 X-AI-Access-Key。 */
async function remoteFetch(
  peer: CdsPeer,
  path: string,
  init: { method?: string; body?: string; timeoutMs?: number } = {},
  fallbackKey?: string,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const key = resolvePeerKey(peer, fallbackKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);
  try {
    const resp = await fetch(`${peer.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(key ? { 'X-AI-Access-Key': key } : {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body,
      signal: controller.signal,
    });
    const text = await resp.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: resp.ok, status: resp.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 构建本项目可复刻的 cds-compose 配置 —— 与 GET /api/export-config?project= 同一口径
 * (toCdsCompose),保证导出再到远端 import-config 能无损复刻。
 */
function buildProjectComposeYaml(stateService: StateService, projectId: string): string {
  const profiles: BuildProfile[] = stateService.getBuildProfilesForProject(projectId);
  const envVars: Record<string, string> = stateService.getCustomEnv(projectId);
  const infra: InfraService[] = stateService.getInfraServicesForProject(projectId);
  const rules: RoutingRule[] = stateService.getRoutingRulesForProject(projectId);
  return toCdsCompose(profiles, envVars, infra, rules);
}

export function createProjectMigrationRouter(deps: ProjectMigrationDeps): Router {
  const router = Router();
  const { stateService } = deps;

  // 本机回退 key:server 鉴权既认 process.env(CDS_AI_ACCESS_KEY / AI_ACCESS_KEY)也认
  // Dashboard 全局变量里的 AI_ACCESS_KEY(getCustomEnv() 合并 _global)。peer 未配自带 key 且
  // 与本机同 key 时,两处都要看,否则 Dashboard 配 key 的装机会误判「缺 key」(Codex P2)。
  function localFallbackKey(): string | undefined {
    const fromEnv = getCdsAiAccessKey();
    if (fromEnv) return fromEnv;
    const globalEnv = stateService.getCustomEnv() as Record<string, string> | undefined;
    return globalEnv?.['AI_ACCESS_KEY'] || undefined;
  }

  function guard(req: any, res: any, projectId: string): boolean {
    // 迁移会跨节点 + verify/replicate/data-plan 在 peer 未配 key 时回退本机 bootstrap
    // AI_ACCESS_KEY 当 X-AI-Access-Key 打远端 → 属于「会外泄本机密钥」的敏感操作。必须**人类
    // 管理员**(CDS cookie 或 GitHub 会话)才能用:AI 会话(x-cds-ai-token / _aiSession)、
    // 项目级/全局 Agent Key、静态 AI_ACCESS_KEY 一律拒绝——否则任一非人类调用方都能加一个
    // 攻击者控制 baseUrl 的 peer,诱导服务端把 bootstrap key 发出去外泄(Bugbot High / Codex P1)。
    // 判定口径与 operator-console / remote-hosts 等系统级管理端一致(secret-revealing 须 cookie 鉴权)。
    // disabled 模式 = 开放面板,无任何登录/标记,且本就没有安全边界(谁都能调任意 API),
    // 强求人类管理员会让迁移在默认 disabled 装机完全不可用(Codex P2)→ 此模式放行。
    const isHumanAdmin =
      deps.authMode === 'disabled' || req._cdsCookieAuth === true || (!!req.cdsUser && !!req.cdsSession);
    if (!isHumanAdmin) {
      res.status(403).json({
        error: 'human_auth_required',
        message: '项目迁移会用本机密钥鉴权远端,属敏感操作,仅允许已登录的人类管理员(CDS cookie 或 GitHub 会话)执行;AI 会话 / 项目级或全局密钥 / 静态 AI_ACCESS_KEY 一律被拒绝。',
      });
      return false;
    }
    const access = deps.assertProjectAccess(req, projectId);
    if (access) {
      res.status(access.status).json(access.body);
      return false;
    }
    if (!stateService.getProject(projectId)) {
      res.status(404).json({ error: '项目不存在' });
      return false;
    }
    return true;
  }

  // ---- 迁移目标(远端 CDS 节点)管理 ----

  router.get('/projects/:id/migration/peers', (req, res) => {
    if (!guard(req, res, req.params.id)) return;
    res.json({ peers: stateService.getCdsPeers().map(toPublicView) });
  });

  router.post('/projects/:id/migration/peers', (req, res) => {
    if (!guard(req, res, req.params.id)) return;
    const { name, baseUrl, accessKey } = (req.body || {}) as {
      name?: string; baseUrl?: string; accessKey?: string;
    };
    const normalized = normalizeBaseUrl(baseUrl || '');
    if (!normalized) {
      res.status(400).json({ error: '目标节点地址(baseUrl)不能为空' });
      return;
    }
    const peer: CdsPeer = {
      id: `peer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: (name || '').trim() || normalized.replace(/^https?:\/\//, ''),
      baseUrl: normalized,
      // 留空 = 推送时回退本机 AI_ACCESS_KEY(跨节点同密钥场景)
      accessKey: (accessKey || '').trim(),
      createdAt: new Date().toISOString(),
    };
    stateService.addCdsPeer(peer);
    stateService.save();
    res.json({ peer: toPublicView(peer) });
  });

  router.delete('/projects/:id/migration/peers/:peerId', (req, res) => {
    if (!guard(req, res, req.params.id)) return;
    if (!stateService.getCdsPeer(req.params.peerId)) {
      res.status(404).json({ error: '迁移目标不存在' });
      return;
    }
    stateService.removeCdsPeer(req.params.peerId);
    stateService.save();
    res.json({ ok: true });
  });

  router.post('/projects/:id/migration/peers/:peerId/verify', async (req, res) => {
    if (!guard(req, res, req.params.id)) return;
    const peer = stateService.getCdsPeer(req.params.peerId);
    if (!peer) {
      res.status(404).json({ error: '迁移目标不存在' });
      return;
    }
    if (!resolvePeerKey(peer, localFallbackKey())) {
      res.status(400).json({ ok: false, error: '该目标未配置 accessKey,且本机 AI_ACCESS_KEY 也缺失,无法鉴权' });
      return;
    }
    try {
      // 用「真正会用到的端点」验证 key 是否被目标接受:/api/me 在 github-auth 远端会因无 cookie
      // 401、在 auth-disabled 远端会无脑 200,都无法证明 key 有效(Bugbot)。改用 import-config
      // dryRun(空配置,非破坏)——它就是复刻要打的端点,各鉴权模式下都按 X-AI-Access-Key 校验。
      const probe = await remoteFetch(peer, '/api/import-config', {
        method: 'POST',
        body: JSON.stringify({ config: { $schema: 'cds-config', buildProfiles: [] }, dryRun: true }),
        timeoutMs: 15_000,
      }, localFallbackKey());
      if (!probe.ok) {
        res.status(200).json({
          ok: false,
          remoteStatus: probe.status,
          error: probe.status === 401
            ? '鉴权失败:目标 CDS 不接受当前 key'
            : `目标 import-config 返回 HTTP ${probe.status}`,
        });
        return;
      }
      // key 有效。再尽力取个友好名字(/api/me,失败忽略,不影响判定)。
      let label = peer.baseUrl.replace(/^https?:\/\//, '');
      try {
        const me = await remoteFetch(peer, '/api/me', { timeoutMs: 8_000 }, localFallbackKey());
        if (me.ok) {
          const id = (me.json as { username?: string; user?: string } | null) || {};
          label = id.username || id.user || label;
        }
      } catch { /* 仅取名,忽略 */ }
      stateService.updateCdsPeer(peer.id, { lastVerifiedAt: new Date().toISOString(), remoteLabel: label });
      stateService.save();
      res.json({ ok: true, remoteStatus: probe.status, peer: toPublicView(stateService.getCdsPeer(peer.id)!) });
    } catch (err) {
      res.status(200).json({ ok: false, error: `连接失败: ${(err as Error).message}` });
    }
  });

  // ---- 配置复刻(打包导出 + 推到远端 CDS) ----

  router.get('/projects/:id/migration/config-preview', (req, res) => {
    if (!guard(req, res, req.params.id)) return;
    const projectId = req.params.id;
    const yamlText = buildProjectComposeYaml(stateService, projectId);
    res.json({
      yaml: yamlText,
      bytes: Buffer.byteLength(yamlText, 'utf-8'),
      summary: {
        profiles: stateService.getBuildProfilesForProject(projectId).length,
        infra: stateService.getInfraServicesForProject(projectId).length,
        envVars: Object.keys(stateService.getCustomEnv(projectId)).length,
        routingRules: stateService.getRoutingRulesForProject(projectId).length,
      },
    });
  });

  router.post('/projects/:id/migration/replicate-config', async (req, res) => {
    if (!guard(req, res, req.params.id)) return;
    const projectId = req.params.id;
    const { peerId, dryRun = true } = (req.body || {}) as {
      peerId?: string; dryRun?: boolean;
    };
    // 只支持 merge(纯新增/更新)。远端 /api/import-config 的 replace-all 是**全局破坏**:
    // 清空目标 CDS 所有项目的 buildProfiles/env/infra/routingRules,对多项目目标会误删无关项目
    // (Bugbot High / Codex P1)。迁移语义是「把本项目搬过去」,绝不该清空目标整机,故强制 merge。
    const cleanMode = 'merge' as const;
    const peer = peerId ? stateService.getCdsPeer(peerId) : undefined;
    if (!peer) {
      res.status(404).json({ error: '迁移目标不存在,请先在「迁移目标」里添加远端 CDS 节点' });
      return;
    }
    if (!resolvePeerKey(peer, localFallbackKey())) {
      res.status(400).json({ error: '该目标未配置 accessKey,且本机 AI_ACCESS_KEY 缺失,无法推送' });
      return;
    }

    const yamlText = buildProjectComposeYaml(stateService, projectId);
    try {
      const remote = await remoteFetch(peer, '/api/import-config', {
        method: 'POST',
        body: JSON.stringify({ config: yamlText, dryRun: !!dryRun, cleanMode }),
        timeoutMs: 60_000,
      }, localFallbackKey());
      res.status(remote.ok ? 200 : 502).json({
        ok: remote.ok,
        dryRun: !!dryRun,
        cleanMode,
        sentBytes: Buffer.byteLength(yamlText, 'utf-8'),
        remoteStatus: remote.status,
        remoteResult: remote.json ?? remote.text,
        peer: toPublicView(peer),
      });
    } catch (err) {
      res.status(502).json({ ok: false, error: `推送到目标 CDS 失败: ${(err as Error).message}` });
    }
  });

  // ---- 数据迁移扫描(只读) ----
  //
  // 真正的全量库迁移走既有、已测的备份/恢复原语(本机 /api/infra/:id/backup
  // mongodump 流 → 远端 /api/infra/:id/restore mongorestore),本端点只做只读
  // 规划:列出源库的 infra mongo 服务 + 探活目标节点,给出可执行的手动桥接清单。
  router.post('/projects/:id/migration/data-plan', async (req, res) => {
    if (!guard(req, res, req.params.id)) return;
    const projectId = req.params.id;
    const { peerId } = (req.body || {}) as { peerId?: string };
    const peer = peerId ? stateService.getCdsPeer(peerId) : undefined;
    if (!peer) {
      res.status(404).json({ error: '迁移目标不存在' });
      return;
    }

    const sourceStores = stateService
      .getInfraServicesForProject(projectId)
      .filter((s) => /mongo/i.test(s.dockerImage))
      .map((s) => ({ id: s.id, name: s.name, image: s.dockerImage, dbName: s.dbName }));

    let targetReachable = false;
    let targetError: string | undefined;
    try {
      // 同 verify:用 import-config dryRun 探活 + 验 key,而非 /api/me(各鉴权模式下会误报)。
      const probe = await remoteFetch(peer, '/api/import-config', {
        method: 'POST',
        body: JSON.stringify({ config: { $schema: 'cds-config', buildProfiles: [] }, dryRun: true }),
        timeoutMs: 12_000,
      }, localFallbackKey());
      targetReachable = probe.ok;
      if (!probe.ok) targetError = probe.status === 401 ? '鉴权失败:目标不接受当前 key' : `目标返回 HTTP ${probe.status}`;
    } catch (err) {
      targetError = (err as Error).message;
    }

    res.json({
      sourceStores,
      target: { reachable: targetReachable, error: targetError, peer: toPublicView(peer) },
      // 数据落库走已测原语,不在本端点直接执行破坏性写入。
      manualBridge: sourceStores.map((s) => ({
        store: s.id,
        download: `/api/infra/${s.id}/backup?project=${projectId}`,
        restore: `${peer.baseUrl}/api/infra/${s.id}/restore`,
        note: '先在源端下载库快照(mongodump archive+gzip),再上传到目标端同 id 的基础设施恢复。建议先在目标完成配置复刻,使 infra id 对齐。',
      })),
    });
  });

  return router;
}
