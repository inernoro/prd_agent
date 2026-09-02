/**
 * 拓扑体检与服务关系图的对外接口（plan.cds.service-relations 第一批）。
 *
 *   POST /api/compose/lint            body { composeYaml } → 体检报告（cdscli verify、导入前预检）
 *   GET  /api/branches/:id/service-graph → 已部署分支的服务图 + 体检（cdscli topology、画布）
 *
 * 规则只在 services/topology-lint 里写一份；这里不做任何判定。
 */
import { Router, type Request } from 'express';
import type { StateService } from '../services/state.js';
import { buildServiceGraph } from '../services/service-graph.js';
import { lintComposeYaml, lintTopology } from '../services/topology-lint.js';
import { resolveRoute } from '../forwarder/route-resolver.js';
import { resolveProfileForPath } from '../services/route-conventions.js';
import { resolveEffectiveProfile } from '../services/container.js';
import type { RouteRecord } from '../forwarder/types.js';
import { resolveBranchEnvLayers } from '../services/branch-env-layers.js';
import { classifyReference, cdsRefResolverDepsFromState, formatCdsRef, parseCdsRefs, resolveCdsRef, type ResolvedCdsRef } from '../services/cross-project-refs.js';
import { PREVIEW_URL_ENV_KEY, SERVICE_URLS_ENV_KEY, resolveBranchEntrypointsEnv } from '../services/preview-entrypoints.js';
import { maskSecretsInObject } from '../services/secret-masker.js';
import type { LintFinding } from '../services/topology-lint.js';

const MAX_YAML_BYTES = 512 * 1024;

export interface TopologyRouterDeps {
  stateService: StateService;
  /** 生效环境变量装配需要的配置（jwt 签发方、预览根域） */
  envConfig?: { jwtIssuer: string; previewHost?: string };
  assertProjectAccess: (req: Request, projectId: string) => { status: number; body: unknown } | null;
  /** 最近一次发布给 forwarder 的路由表（路由判定查询用；省略时该接口只给 master 兜底的判定） */
  getPublishedRoutes?: () => RouteRecord[];
}

export function createTopologyRouter(deps: TopologyRouterDeps): Router {
  const router = Router();

  router.post('/compose/lint', (req, res) => {
    const body = (req.body ?? {}) as { composeYaml?: unknown; projectId?: unknown };
    const composeYaml = typeof body.composeYaml === 'string' ? body.composeYaml : '';
    if (!composeYaml.trim()) {
      res.status(400).json({ error: 'validation', field: 'composeYaml', message: 'composeYaml 不能为空' });
      return;
    }
    if (composeYaml.length > MAX_YAML_BYTES) {
      res.status(400).json({ error: 'validation', field: 'composeYaml', message: `composeYaml 超出 ${MAX_YAML_BYTES} 字节限制` });
      return;
    }
    if (typeof body.projectId === 'string' && body.projectId) {
      const denied = deps.assertProjectAccess(req, body.projectId);
      if (denied) { res.status(denied.status).json(denied.body); return; }
    }
    const lint = lintComposeYaml(composeYaml);
    if (!lint) {
      res.status(400).json({ error: 'parse_failed', message: 'compose 无法解析为 CDS 配置，体检未运行' });
      return;
    }
    res.json(lint);
  });

  /**
   * 「引用」分区数据（plan.cds.service-relations 第三批）：从全部环境变量里单独抽出像地址的键——
   * 引用变量、值是网址、键名带 URL/BASE/ENDPOINT/HOST 后缀、平台注入的入口表——逐条给出
   * 来源层、指向哪个项目哪个分支哪个服务、目标现在活没活。
   */
  function collectReferences(branchId: string) {
    const branch = deps.stateService.getBranch(branchId);
    if (!branch) return null;
    const envConfig = deps.envConfig ?? { jwtIssuer: 'cds' };
    const resolution = resolveBranchEnvLayers(deps.stateService, branch, envConfig);
    const refDeps = cdsRefResolverDepsFromState(deps.stateService, envConfig.previewHost);
    const branches = deps.stateService.getAllBranches();
    const hostOf = (url: string): string | null => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };
    // 每条分支实际发布的 host（主入口 + 各子域），与容器注入的入口表同一份口径；按需算、算一次
    const branchHosts = new Map<string, string[]>();
    const hostsOfBranch = (b: (typeof branches)[number]): string[] => {
      const cached = branchHosts.get(b.id);
      if (cached) return cached;
      const hosts: string[] = [];
      try {
        const env = resolveBranchEntrypointsEnv(b, refDeps.entrypointDeps).env;
        const main = env[PREVIEW_URL_ENV_KEY] ? hostOf(env[PREVIEW_URL_ENV_KEY]) : null;
        if (main) hosts.push(main);
        const table = JSON.parse(env[SERVICE_URLS_ENV_KEY] || '{}') as Record<string, string>;
        for (const u of Object.values(table)) { const h = hostOf(u); if (h) hosts.push(h); }
      } catch { /* 入口表算不出来就当没有 host */ }
      branchHosts.set(b.id, hosts);
      return hosts;
    };
    const items: Array<{
      profileId: string; key: string; kind: ReturnType<typeof classifyReference>; value: string; rawValue: string;
      source: string; detail?: string; resolved?: ResolvedCdsRef[]; matchedBranch?: { branchId: string; projectId: string; branchName: string; status: string } | null;
      suggestion?: string;
    }> = [];
    const broken: LintFinding[] = [];
    for (const prof of resolution.profiles) {
      // 用合并前各层的原始值找引用（解析后的值已经是地址，看不出它原本是引用）
      const rawByKey = new Map<string, string>();
      for (const layer of [...resolution.customLayers, ...prof.profileLayers]) {
        for (const [k, v] of Object.entries(layer.env)) rawByKey.set(k, String(v ?? ''));
      }
      for (const p of prof.provenance) {
        const raw = rawByKey.get(p.key) ?? p.value;
        const kind = classifyReference(p.key, raw) ?? classifyReference(p.key, p.value);
        if (!kind) continue;
        const masked = maskSecretsInObject({ [p.key]: p.value })[p.key] ?? p.value;
        const item: (typeof items)[number] = {
          profileId: prof.baseline.id, key: p.key, kind, value: masked,
          rawValue: maskSecretsInObject({ [p.key]: raw })[p.key] ?? raw, source: p.source, ...(p.detail ? { detail: p.detail } : {}),
        };
        if (kind === 'cds-ref') {
          item.resolved = parseCdsRefs(raw).map((ref) => resolveCdsRef(refDeps, ref));
          for (const r of item.resolved) {
            if (r.status === 'running') continue;
            broken.push({
              rule: 'reference-broken',
              severity: r.url ? 'warn' : 'error',
              services: [prof.baseline.id],
              message: `${prof.baseline.id} 的 ${p.key} 引用 ${r.ref.projectRef}/${r.ref.serviceId}${r.ref.branchRef ? `@${r.ref.branchRef}` : ''}，目标${r.reason ? `：${r.reason}` : `分支 ${r.target.branchName ?? ''} 状态 ${r.status}`}`,
              fix: r.url ? '切换到一个在跑的目标分支，或唤醒目标分支' : '检查项目、分支、服务名是否写对',
            });
          }
        } else if (kind === 'url') {
          const host = hostOf(p.value);
          const hit = host ? branches.find((b) => hostsOfBranch(b).includes(host)) : undefined;
          item.matchedBranch = hit ? { branchId: hit.id, projectId: hit.projectId, branchName: hit.branch, status: String(hit.status) } : null;
          if (hit && hit.id === branch.id) item.suggestion = '这是本分支自己的入口，改成 ${CDS_PREVIEW_URL} 就不会随分支改名失效';
          else if (hit) item.suggestion = `这是 CDS 上另一条分支的地址，改成引用变量后可以在这里切换：${formatCdsRef({ projectRef: hit.projectId, serviceId: '<服务>', branchRef: hit.branch })}`;
        }
        items.push(item);
      }
    }
    items.sort((a, b) => (a.kind === 'cds-ref' ? 0 : a.kind === 'url' ? 1 : a.kind === 'name-hint' ? 2 : 3) - (b.kind === 'cds-ref' ? 0 : b.kind === 'url' ? 1 : b.kind === 'name-hint' ? 2 : 3) || a.key.localeCompare(b.key));
    return { branch, items, broken };
  }

  router.get('/branches/:id/references', (req, res) => {
    const collected = collectReferences(req.params.id);
    if (!collected) { res.status(404).json({ error: 'not_found', message: `分支不存在: ${req.params.id}` }); return; }
    const denied = deps.assertProjectAccess(req, collected.branch.projectId);
    if (denied) { res.status(denied.status).json(denied.body); return; }
    res.json({ branchId: collected.branch.id, projectId: collected.branch.projectId, references: collected.items, broken: collected.broken });
  });

  /**
   * 切换引用指向（写进分支级覆盖，不动项目根）：body { projectRef, serviceId, branchRef? }。
   * 返回解析结果，前端据此提示「切换并重启」。
   */
  router.put('/branches/:id/references/:key', (req, res) => {
    const branch = deps.stateService.getBranch(req.params.id);
    if (!branch) { res.status(404).json({ error: 'not_found', message: `分支不存在: ${req.params.id}` }); return; }
    const denied = deps.assertProjectAccess(req, branch.projectId);
    if (denied) { res.status(denied.status).json(denied.body); return; }
    const key = String(req.params.key || '').trim();
    const body = (req.body ?? {}) as { projectRef?: unknown; serviceId?: unknown; branchRef?: unknown; profileId?: unknown };
    const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : '';
    const projectRef = typeof body.projectRef === 'string' ? body.projectRef.trim() : '';
    const serviceId = typeof body.serviceId === 'string' ? body.serviceId.trim() : '';
    const branchRef = typeof body.branchRef === 'string' && body.branchRef.trim() ? body.branchRef.trim() : undefined;
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) { res.status(400).json({ error: 'validation', field: 'key', message: '键名不合法' }); return; }
    if (!projectRef || !serviceId || !profileId) { res.status(400).json({ error: 'validation', message: 'profileId、projectRef 与 serviceId 必填' }); return; }
    if (!deps.stateService.getEffectiveProfilesForBranch(branch).some((p) => p.id === profileId)) {
      res.status(404).json({ error: 'not_found', message: `分支上没有服务 ${profileId}` });
      return;
    }
    const value = formatCdsRef({ projectRef, serviceId, branchRef });
    const [ref] = parseCdsRefs(value);
    if (!ref) { res.status(400).json({ error: 'validation', message: '引用写法不合法（项目、服务、分支只能含字母数字与 _ . ~ -）' }); return; }
    const envConfig = deps.envConfig ?? { jwtIssuer: 'cds' };
    const resolved = resolveCdsRef(cdsRefResolverDepsFromState(deps.stateService, envConfig.previewHost), ref);
    if (resolved.status === 'missing-project' || resolved.status === 'missing-branch' || resolved.status === 'missing-service') {
      res.status(409).json({ error: 'reference_unresolvable', message: resolved.reason, resolved });
      return;
    }
    // 写进该服务的分支级覆盖（profileOverrides.env）：它在合并顺序里压过项目根的 profile.env，
    // 分支级 customEnv 压不过 profile.env，写那里等于没切。不动项目根，别的分支不受影响。
    const existing = branch.profileOverrides?.[profileId] ?? {};
    deps.stateService.setBranchProfileOverride(branch.id, profileId, {
      ...existing,
      env: { ...(existing.env ?? {}), [key]: value },
    });
    res.json({ branchId: branch.id, profileId, key, value, resolved, scope: 'branch-override', restartHint: '切换写入该服务的分支覆盖，重启它后生效' });
  });

  /** 分支服务图 + 体检 + 引用（service-graph 接口与全局概览共用同一份计算）。 */
  function buildBranchGraphPayload(branch: NonNullable<ReturnType<StateService['getBranch']>>) {
    // env 用生效合并结果（与 replica-sets 的服务图同一口径），只暴露键名
    const projectEnv = deps.stateService.getCustomEnv(branch.projectId);
    const branchEnv = deps.stateService.getCustomEnvScope(branch.id);
    const profiles = deps.stateService.getEffectiveProfilesForBranch(branch)
      .map((p) => ({ ...p, env: { ...projectEnv, ...branchEnv, ...(p.env || {}) } }));
    const infra = (deps.stateService.getState().infraServices || [])
      .filter((s) => s.projectId === branch.projectId && (s.scope ?? 'project') === 'project');
    const graph = buildServiceGraph(profiles, infra);
    const lint = lintTopology(graph);
    // 引用断裂并进同一份体检（关系图、缩略卡、cdscli topology 看到的是同一份）
    const collected = collectReferences(branch.id);
    const references = collected?.items ?? [];
    for (const f of collected?.broken ?? []) lint.findings.push(f);
    lint.findings.sort((a, b) => ({ error: 0, warn: 1, info: 2 })[a.severity] - ({ error: 0, warn: 1, info: 2 })[b.severity]);
    lint.summary = {
      errors: lint.findings.filter((f) => f.severity === 'error').length,
      warnings: lint.findings.filter((f) => f.severity === 'warn').length,
      infos: lint.findings.filter((f) => f.severity === 'info').length,
    };
    return { branchId: branch.id, projectId: branch.projectId, branch: branch.branch, status: String(branch.status), graph, lint, references };
  }

  router.get('/branches/:id/service-graph', (req, res) => {
    const branch = deps.stateService.getBranch(req.params.id);
    if (!branch) { res.status(404).json({ error: 'not_found', message: `分支不存在: ${req.params.id}` }); return; }
    const denied = deps.assertProjectAccess(req, branch.projectId);
    if (denied) { res.status(denied.status).json(denied.body); return; }
    res.json(buildBranchGraphPayload(branch));
  });

  /**
   * 全局概览（plan.cds.service-relations 第四批）：每个项目取代表分支（默认分支，没有就取最近
   * 部署的那条），给出体检结论、服务构成、跨项目引用边。只返回调用方有权限的项目。
   */
  router.get('/overview/topology', (req, res) => {
    const projects = (deps.stateService.getState().projects ?? []).filter((p) => !deps.assertProjectAccess(req, p.id));
    const branches = deps.stateService.getAllBranches();
    const out = projects.map((project) => {
      const p = project as typeof project & { gitDefaultBranch?: string | null; defaultBranch?: string | null };
      const mine = branches.filter((b) => b.projectId === project.id);
      const wanted = (p.gitDefaultBranch || p.defaultBranch || 'main').trim();
      const rep = mine.find((b) => b.branch === wanted)
        ?? [...mine].sort((a, b) => String((b as { lastDeployAt?: string }).lastDeployAt ?? b.createdAt ?? '').localeCompare(String((a as { lastDeployAt?: string }).lastDeployAt ?? a.createdAt ?? '')))[0];
      if (!rep) {
        return { projectId: project.id, slug: project.slug, name: project.name, branch: null, branchCount: 0, counts: { services: 0, sites: 0, apis: 0, webs: 0, workers: 0 }, lint: { errors: 0, warnings: 0, infos: 0 }, headline: '还没有分支', findings: [], edges: [] };
      }
      const payload = buildBranchGraphPayload(rep);
      const services = payload.graph.nodes.filter((n) => n.kind === 'service');
      const edges: Array<{ toProjectId: string; toBranchId?: string; toBranchName?: string; kind: 'cds-ref' | 'url'; status: string; fromService: string; key: string }> = [];
      for (const r of payload.references) {
        if (r.kind === 'cds-ref') {
          for (const x of r.resolved ?? []) {
            if (x.target.projectId && x.target.projectId !== project.id) {
              edges.push({ toProjectId: x.target.projectId, toBranchId: x.target.branchId, toBranchName: x.target.branchName, kind: 'cds-ref', status: x.status, fromService: r.profileId, key: r.key });
            }
          }
        } else if (r.kind === 'url' && r.matchedBranch && r.matchedBranch.projectId !== project.id) {
          edges.push({ toProjectId: r.matchedBranch.projectId, toBranchId: r.matchedBranch.branchId, toBranchName: r.matchedBranch.branchName, kind: 'url', status: r.matchedBranch.status, fromService: r.profileId, key: r.key });
        }
      }
      const top = payload.lint.findings[0];
      return {
        projectId: project.id, slug: project.slug, name: project.name,
        branch: { id: rep.id, name: rep.branch, status: String(rep.status) },
        branchCount: mine.length,
        counts: {
          services: services.length,
          sites: payload.graph.sites.length,
          apis: services.filter((n) => n.role === 'api').length,
          webs: services.filter((n) => n.role === 'web').length,
          workers: services.filter((n) => n.role === 'worker').length,
        },
        lint: payload.lint.summary,
        headline: top ? top.message : '无问题',
        findings: payload.lint.findings.slice(0, 8),
        edges,
      };
    });
    const inbound = new Map<string, number>();
    for (const p of out) for (const e of p.edges) inbound.set(e.toProjectId, (inbound.get(e.toProjectId) ?? 0) + 1);
    res.json({
      generatedAt: new Date().toISOString(),
      summary: {
        errors: out.reduce((n, p) => n + p.lint.errors, 0),
        warnings: out.reduce((n, p) => n + p.lint.warnings, 0),
        infos: out.reduce((n, p) => n + p.lint.infos, 0),
      },
      projects: out.map((p) => ({ ...p, inboundEdges: inbound.get(p.projectId) ?? 0 })),
    });
  });

  /**
   * 路由判定查询（plan.cds.service-relations 第二批）：输入 host + path，回答
   * 「转发器现在会把它交给哪条路由 / 哪个服务」以及「master 兜底会选谁」。两者不一致就是漂移。
   */
  router.get('/branches/:id/route-lookup', (req, res) => {
    const branch = deps.stateService.getBranch(req.params.id);
    if (!branch) { res.status(404).json({ error: 'not_found', message: `分支不存在: ${req.params.id}` }); return; }
    const denied = deps.assertProjectAccess(req, branch.projectId);
    if (denied) { res.status(denied.status).json(denied.body); return; }
    const host = String(req.query.host ?? '').trim().toLowerCase();
    const path = String(req.query.path ?? '/').trim() || '/';
    if (!host) { res.status(400).json({ error: 'validation', field: 'host', message: 'host 不能为空' }); return; }
    const routes = (deps.getPublishedRoutes?.() ?? []).filter((r) => r.branchId === branch.id);
    const hit = resolveRoute(routes, host, path);
    const profiles = deps.stateService.getEffectiveProfilesForBranch(branch)
      .map((p) => resolveEffectiveProfile(p, branch))
      .filter((p) => Object.keys(branch.services ?? {}).includes(p.id));
    const masterPick = resolveProfileForPath(profiles, path);
    res.json({
      branchId: branch.id,
      host,
      path,
      forwarder: hit
        ? { routeId: hit._id, profileId: hit.profileId ?? null, pathPrefix: hit.pathPrefix ?? '', upstreamPort: hit.upstreamPort, replicaMemberId: hit.replicaMemberId ?? null }
        : null,
      masterFallback: { profileId: masterPick ?? null },
      consistent: hit ? (hit.profileId ?? null) === (masterPick ?? null) : null,
      publishedRoutes: routes.length,
    });
  });

  return router;
}
