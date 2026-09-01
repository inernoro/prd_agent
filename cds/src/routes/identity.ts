/**
 * 身份层路由 —— 主体、用户级凭证、项目授权、权限总览。
 *
 * ## 两级凭证的分工
 *
 * - **用户级**（`cdsu_`，放用户目录）：**发钥匙的钥匙**。权限刻意最窄、寿命最长——
 *   能建项目、能列出我可见的项目、能为**我已获授权的项目**签项目级凭证；不能删
 *   分支、改配置、跑运维指令。可达路由由 {@link userCredentialRouteAllowed} 一处
 *   收口，理由与 connection-token-routes 相同：散在鉴权代码里写 startsWith，
 *   每加一条能力就多一处判断，最终没人答得上来「这把凭证到底能干什么」。
 * - **项目级**（`cdsp_`，放仓库根）：干活的那把。由用户级签出来，短命、可随时重签。
 *
 * ## 「只授权不操作」不是拦截，是留痕
 *
 * 拿到用户级凭证的人仍然可以先签一张项目级、再用它去删东西，只是多走一步。
 * 它换来的是两样别的东西：每一次签发都必然留下记录（直接操作不留痕，签发一定
 * 留痕），以及一处可一键切断的总闸（撤用户级即级联撤下游）。所以签发计数、
 * 有效期、级联撤销是这套设计成立的前提，不是装饰。
 */

import { Router } from 'express';
import crypto from 'node:crypto';
import type { StateService } from '../services/state.js';
import type { AgentKey, Principal, ProjectGrant, UserCredential } from '../types.js';
import {
  buildPrincipalOverview,
  cascadeRevokeTargets,
  credentialUsability,
  daysFromNow,
  decideProjectCredentialIssue,
  PROJECT_CREDENTIAL_TTL_DAYS,
  slideExpiry,
  USER_CREDENTIAL_TTL_DAYS,
} from '../services/identity.js';

export interface IdentityRouterDeps {
  stateService: StateService;
  /** disabled 模式（本地 dev 全站无鉴权）下 dashboard 用户即管理员。 */
  authMode?: 'disabled' | 'basic' | 'github';
}

/**
 * 用户级凭证能到达哪些路由 —— 唯一一张表。
 *
 * 加新条目前先问三句：这条路由属于「建项目 / 列项目 / 发钥匙」三件事之一吗？
 * 它会不会直接改动某个项目里的东西？用户在签发这张凭证时看到的说明涵盖它吗？
 * 三句里有一句答不上来，就不该加 —— 否则「发钥匙的钥匙」会悄悄长成万能钥匙，
 * 那正是第一阶段那把 access key 的老路。
 */
export function userCredentialRouteAllowed(method: string, path: string): boolean {
  const m = method.toUpperCase();
  // 自愈核心：为已授权项目补一张项目级凭证
  if (m === 'POST' && path === '/api/identity/project-credentials') return true;
  // 我是谁 / 我有哪些授权
  if (m === 'GET' && path === '/api/identity/whoami') return true;
  // 能列项目、能建项目 —— 这两件事本来就是用户级凭证存在的理由
  if (m === 'GET' && path === '/api/projects') return true;
  if (m === 'POST' && path === '/api/projects') return true;
  return false;
}

function newId(prefix: string, bytes = 6): string {
  return `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** 生成一把用户级凭证明文。前缀让鉴权层一眼认出它属于哪一类。 */
export function mintUserCredentialPlaintext(): string {
  return `cdsu_${crypto.randomBytes(24).toString('base64url')}`;
}

/** 生成一把项目级凭证明文，格式与既有签发路径逐字一致（复用一切既有防护）。 */
export function mintProjectCredentialPlaintext(projectSlug: string): string {
  const head = projectSlug.slice(0, 12).toLowerCase();
  return `cdsp_${head}_${crypto.randomBytes(24).toString('base64url')}`;
}

export function createIdentityRouter(deps: IdentityRouterDeps): Router {
  const router = Router();
  const { stateService } = deps;

  /** 管理动作要求「不是项目级凭证」—— 项目级凭证只管自己那个项目，管不了身份。 */
  function requireAdmin(req: unknown): { ok: true } | { ok: false; body: Record<string, unknown> } {
    const projectKey = (req as { cdsProjectKey?: unknown }).cdsProjectKey;
    if (projectKey) {
      return {
        ok: false,
        body: {
          error: 'forbidden',
          message: '项目级凭证只管自己那个项目，不能管理身份、凭证或授权。',
        },
      };
    }
    return { ok: true };
  }

  function actorOf(req: unknown): string | undefined {
    const marker = req as { cdsUser?: { username?: string; githubLogin?: string } };
    return marker.cdsUser?.username || marker.cdsUser?.githubLogin;
  }

  function projectNameMap(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const project of stateService.getState().projects || []) {
      out[project.id] = project.aliasName || project.name;
    }
    return out;
  }

  // ── 权限总览：按主体聚合，不按钥匙平铺 ──────────────────────────
  router.get('/identity/overview', (req, res) => {
    const admin = requireAdmin(req);
    if (!admin.ok) { res.status(403).json(admin.body); return; }
    const overview = buildPrincipalOverview({
      principals: stateService.getPrincipals(),
      userCredentials: stateService.getUserCredentials(),
      projectCredentials: stateService.getAllAgentKeysWithProject(),
      grants: stateService.getProjectGrants(),
      projectNameById: projectNameMap(),
    });
    res.json({ ok: true, ...overview });
  });

  // ── 签发用户级凭证（从已登录会话换，不是凭空自签）────────────────
  //
  // 「自己签发」不能是「凭空签发」：无条件自签等于任何能连上 CDS 的人都能拿到
  // 最高身份。这条路由要求调用方已经是管理员身份（cookie 会话或非项目级凭证），
  // 于是它换来的是「我已经登录了，给这台机器一张凭证」——连审批都不像。
  router.post('/identity/user-credentials', (req, res) => {
    const admin = requireAdmin(req);
    if (!admin.ok) { res.status(403).json(admin.body); return; }
    const body = (req.body || {}) as { principalId?: string; name?: string; kind?: Principal['kind']; label?: string };
    const actor = actorOf(req);

    let principal = body.principalId ? stateService.getPrincipal(body.principalId) : undefined;
    if (body.principalId && !principal) {
      res.status(404).json({ error: 'principal_not_found', message: `主体 ${body.principalId} 不存在` });
      return;
    }
    if (!principal) {
      const name = (body.name || '').trim();
      if (!name) {
        res.status(400).json({ error: 'bad_request', message: '新建主体必须给一个名字（这台机器 / 这个智能体叫什么）' });
        return;
      }
      principal = {
        id: newId('pr'),
        name: name.slice(0, 100),
        kind: body.kind === 'human' || body.kind === 'agent' ? body.kind : 'machine',
        status: 'active',
        createdAt: new Date().toISOString(),
        ...(actor ? { createdBy: actor } : {}),
      };
      stateService.addPrincipal(principal);
    }
    if (principal.status !== 'active') {
      res.status(403).json({ error: 'principal_disabled', message: '该主体已被停用，不能签发凭证' });
      return;
    }

    const plaintext = mintUserCredentialPlaintext();
    const entry: UserCredential = {
      id: newId('uc'),
      principalId: principal.id,
      hash: sha256(plaintext),
      ...(body.label ? { label: String(body.label).slice(0, 100) } : {}),
      createdAt: new Date().toISOString(),
      ...(actor ? { createdBy: actor } : {}),
      expiresAt: daysFromNow(USER_CREDENTIAL_TTL_DAYS),
    };
    stateService.addUserCredential(entry);
    // 明文只在这里出现一次，不落库、不进日志。
    res.status(201).json({
      ok: true,
      principal,
      credential: { id: entry.id, expiresAt: entry.expiresAt, createdAt: entry.createdAt },
      plaintext,
      reach: '只能建项目、列项目、为已授权项目签发项目级凭证；不能删分支、改配置、跑运维指令。',
    });
  });

  // ── 自愈核心：用用户级凭证为已授权项目补一张项目级凭证 ────────────
  router.post('/identity/project-credentials', (req, res) => {
    const principalId = (req as { cdsPrincipal?: { principalId: string; credentialId: string } }).cdsPrincipal;
    if (!principalId) {
      res.status(401).json({
        error: 'user_credential_required',
        message: '这条路由要用用户级凭证（cdsu_）调用；它是「发钥匙的钥匙」。',
      });
      return;
    }
    const body = (req.body || {}) as { projectId?: string; label?: string };
    const projectId = (body.projectId || '').trim();
    if (!projectId) {
      res.status(400).json({ error: 'bad_request', message: 'projectId 必填' });
      return;
    }
    const project = stateService.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: 'project_not_found', message: `项目 ${projectId} 不存在` });
      return;
    }
    const principal = stateService.getPrincipal(principalId.principalId);
    const decision = decideProjectCredentialIssue(principal, stateService.getProjectGrants(), projectId);
    if (!decision.allowed) {
      res.status(403).json({
        error: decision.reason === 'no-grant' ? 'no_grant' : 'principal_disabled',
        message: decision.message,
        // 没授权不是死路：明确指出走哪条，而不是丢一句 403
        nextStep: decision.reason === 'no-grant'
          ? '在该项目发起一次接入申请，由人在页面上批准一次；此后同一主体换机器、丢凭据都不必再批。'
          : '联系管理员恢复该主体。',
      });
      return;
    }

    const plaintext = mintProjectCredentialPlaintext(project.slug);
    const key: AgentKey = {
      id: crypto.randomBytes(4).toString('hex'),
      label: (body.label || `由 ${principal?.name || '主体'} 自助补发`).slice(0, 100),
      hash: sha256(plaintext),
      scope: 'rw',
      createdAt: new Date().toISOString(),
      principalId: principalId.principalId,
      issuedByCredentialId: principalId.credentialId,
      expiresAt: daysFromNow(PROJECT_CREDENTIAL_TTL_DAYS),
    };
    stateService.addAgentKey(project.id, key);
    // 签发留痕：留痕是这套设计唯一的安全收益，不记等于没有。
    stateService.recordUserCredentialIssue(principalId.credentialId);
    res.status(201).json({
      ok: true,
      projectId: project.id,
      projectSlug: project.slug,
      credential: { id: key.id, expiresAt: key.expiresAt },
      plaintext,
      grantOrigin: decision.grant.origin,
    });
  });

  // ── 我是谁 / 我有哪些授权 ────────────────────────────────────────
  router.get('/identity/whoami', (req, res) => {
    const ctx = (req as { cdsPrincipal?: { principalId: string; credentialId: string } }).cdsPrincipal;
    if (!ctx) {
      res.status(401).json({ error: 'user_credential_required', message: '需要用户级凭证（cdsu_）' });
      return;
    }
    const principal = stateService.getPrincipal(ctx.principalId);
    const names = projectNameMap();
    const grants = stateService.getProjectGrants()
      .filter((g) => g.principalId === ctx.principalId && !g.revokedAt)
      .map((g) => ({ projectId: g.projectId, projectName: names[g.projectId], origin: g.origin }));
    res.json({ ok: true, principal, grants });
  });

  // ── 撤销用户级凭证（级联撤下游）──────────────────────────────────
  router.post('/identity/user-credentials/:id/revoke', (req, res) => {
    const admin = requireAdmin(req);
    if (!admin.ok) { res.status(403).json(admin.body); return; }
    const { id } = req.params;
    const actor = actorOf(req);
    if (!stateService.revokeUserCredential(id, actor)) {
      res.status(404).json({ error: 'not_found', message: `凭证 ${id} 不存在` });
      return;
    }
    // 级联：撤了源头却留着下游，等于撤了个寂寞。
    const targets = cascadeRevokeTargets(stateService.getAllAgentKeysWithProject(), id);
    for (const target of targets) {
      if (target.projectId) stateService.revokeAgentKey(target.projectId, target.keyId);
    }
    res.json({ ok: true, revoked: id, cascadedCount: targets.length, cascaded: targets });
  });

  // ── 停用 / 恢复主体 ─────────────────────────────────────────────
  router.post('/identity/principals/:id/status', (req, res) => {
    const admin = requireAdmin(req);
    if (!admin.ok) { res.status(403).json(admin.body); return; }
    const body = (req.body || {}) as { status?: Principal['status'] };
    const status = body.status === 'disabled' ? 'disabled' : 'active';
    if (!stateService.setPrincipalStatus(req.params.id, status, actorOf(req))) {
      res.status(404).json({ error: 'not_found', message: `主体 ${req.params.id} 不存在` });
      return;
    }
    res.json({ ok: true, principalId: req.params.id, status });
  });

  // ── 授予 / 撤销项目授权 ─────────────────────────────────────────
  router.post('/identity/grants', (req, res) => {
    const admin = requireAdmin(req);
    if (!admin.ok) { res.status(403).json(admin.body); return; }
    const body = (req.body || {}) as { principalId?: string; projectId?: string; origin?: ProjectGrant['origin'] };
    const principalId = (body.principalId || '').trim();
    const projectId = (body.projectId || '').trim();
    if (!principalId || !projectId) {
      res.status(400).json({ error: 'bad_request', message: 'principalId 与 projectId 均为必填' });
      return;
    }
    if (!stateService.getPrincipal(principalId)) {
      res.status(404).json({ error: 'principal_not_found', message: `主体 ${principalId} 不存在` });
      return;
    }
    if (!stateService.getProject(projectId)) {
      res.status(404).json({ error: 'project_not_found', message: `项目 ${projectId} 不存在` });
      return;
    }
    const grant: ProjectGrant = {
      id: newId('pg'),
      projectId,
      principalId,
      origin: body.origin === 'created' ? 'created' : 'approved',
      grantedAt: new Date().toISOString(),
      ...(actorOf(req) ? { grantedBy: actorOf(req) as string } : {}),
    };
    stateService.addProjectGrant(grant);
    res.status(201).json({ ok: true, grant });
  });

  router.post('/identity/grants/:id/revoke', (req, res) => {
    const admin = requireAdmin(req);
    if (!admin.ok) { res.status(403).json(admin.body); return; }
    if (!stateService.revokeProjectGrant(req.params.id, actorOf(req))) {
      res.status(404).json({ error: 'not_found', message: `授权 ${req.params.id} 不存在` });
      return;
    }
    res.json({ ok: true, revoked: req.params.id });
  });

  return router;
}

/**
 * 鉴权层用的解析器：把明文 `cdsu_` 解析成可用的主体上下文。
 *
 * 过期判定统一走 identity.credentialUsability，不在这里另写一份 —— 两处各写
 * 一份过期逻辑然后漂移，是这套代码库反复踩过的形状。
 */
export function resolveUserCredential(
  stateService: StateService,
  plaintextKey: string,
): { principalId: string; credentialId: string } | null {
  const cred = stateService.findUserCredentialByPlaintext(plaintextKey);
  if (!cred) return null;
  const principal = stateService.getPrincipal(cred.principalId);
  const usability = credentialUsability(cred, principal, Date.now(), true);
  if (!usability.usable) return null;
  // 用一次自动续 90 天：天天在用的永不打断，闲置三个月的自动失效。
  const nextExpiry = slideExpiry(cred.expiresAt, USER_CREDENTIAL_TTL_DAYS);
  stateService.touchUserCredential(cred.id, nextExpiry);
  stateService.touchPrincipalSeen(cred.principalId);
  return { principalId: cred.principalId, credentialId: cred.id };
}
