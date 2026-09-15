/**
 * 拓扑体检（唯一定义处，doc/plan.cds.service-relations.md 第一批）。
 *
 * 输入是服务图（service-graph 已算出角色、站点、冲突、边），输出一组带严重度的发现。
 * 画布、导入审批、cdscli verify 三处都调这一份，禁止各写各的判据
 * （predicate-and-wiring-discipline 形状 3）。
 *
 * 严重度：
 *   error   会让 forwarder 二选一、把探活暴露到公网，或让服务永远收不到流量——阻断导入；
 *   warn    结构可疑但能跑（子域又抢主域名根路径、一个服务两个公网面、游离服务）；
 *   info    建议（角色靠名字推断）。
 */
import type { ServiceGraph, ServiceGraphSite } from './service-graph.js';
import { parseNodeId, buildServiceGraph } from './service-graph.js';
import { parseCdsCompose } from './compose-parser.js';
import type { BuildProfile, InfraService } from '../types.js';

export type LintSeverity = 'error' | 'warn' | 'info';

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  /** 涉及的服务 id（排序后），给界面高亮与 cdscli 按服务归组 */
  services: string[];
  message: string;
  fix: string;
}

export interface TopologyLintReport {
  findings: LintFinding[];
  summary: { errors: number; warnings: number; infos: number };
}

/** 探活语义的路径段（与 web-entry / service-graph 同一份口径） */
export const OPERATIONAL_PROBE_PREFIX_RE = /(?:^|\/)(?:health|healthz|health-check|ready|readyz|readiness|live|livez|liveness|actuator|metrics)(?:\/|\?|$)/i;

/** 路由前缀是不是探活路径（`/health`、`/actuator/`、`/api/health` 都算） */
export function isProbePrefix(prefix: string): boolean {
  return OPERATIONAL_PROBE_PREFIX_RE.test(prefix.trim());
}

function mainSite(graph: ServiceGraph): ServiceGraphSite | undefined {
  return graph.sites.find((s) => s.kind === 'main');
}

export function lintTopology(graph: ServiceGraph): TopologyLintReport {
  const findings: LintFinding[] = [];
  const services = graph.nodes.filter((n) => n.kind === 'service');
  const byId = new Map(services.map((n) => [n.rawId, n]));
  const main = mainSite(graph);

  // 1) 同一 host 上同一前缀被多个服务声明 → error
  for (const c of main?.conflicts ?? []) {
    findings.push({
      rule: 'prefix-conflict',
      severity: 'error',
      services: [...c.ids].sort(),
      message: `路由前缀 ${c.prefix} 被 ${c.ids.join('、')} 同时声明，forwarder 只能按部署顺序二选一，另一个永远收不到这条流量`,
      fix: `只保留一个声明方：从其余服务的 cds.path-prefix 里删掉 ${c.prefix}`,
    });
  }

  // 2) 探活路径进了路由前缀 → error（探活只打容器端口，公网不需要这条路由）
  for (const n of services) {
    const probes = (n.pathPrefixes ?? []).filter((p) => p.trim() !== '/' && isProbePrefix(p));
    if (probes.length === 0) continue;
    findings.push({
      rule: 'probe-in-prefix',
      severity: 'error',
      services: [n.rawId],
      message: `${n.rawId} 把探活路径 ${probes.join('、')} 写进了 cds.path-prefix，探活只打容器端口，公网不该有这条路由`,
      fix: `从 cds.path-prefix 里删掉 ${probes.join('、')}，探活继续只写 cds.readiness-path`,
    });
  }

  // 3) 有子域又在主域名声明根路径 → warn（主域名根路径另有壳时它靠 id 排序才没抢到）
  for (const n of services) {
    if (!n.subdomain) continue;
    const ownsRoot = (n.pathPrefixes ?? []).some((p) => p.trim() === '/');
    if (!ownsRoot) continue;
    if (main?.shellId === n.rawId) continue;
    findings.push({
      rule: 'subdomain-root-claim',
      severity: 'warn',
      services: [n.rawId],
      message: `${n.rawId} 独占子域 ${n.subdomain}，又在主域名声明了根路径 /，主域名的壳是 ${main?.shellId ?? '（无）'}，两者靠 id 排序分胜负`,
      fix: `删掉 ${n.rawId} 的 cds.path-prefix: /，只留 cds.subdomain`,
    });
  }

  // 4) 一个服务两个公网面（子域 + 主域名前缀）→ warn
  for (const n of services) {
    if (!n.subdomain) continue;
    const nonRoot = (n.pathPrefixes ?? []).map((p) => p.trim()).filter((p) => p && p !== '/');
    if (nonRoot.length === 0) continue;
    findings.push({
      rule: 'double-public-surface',
      severity: 'warn',
      services: [n.rawId],
      message: `${n.rawId} 同时暴露在子域 ${n.subdomain} 和主域名前缀 ${nonRoot.join('、')} 上，一个服务两个公网入口`,
      fix: '二选一：只留子域（整站归它），或只留主域名前缀',
    });
  }

  // 5) 游离服务：无公网路由、无人调用、不调用别人、无显式角色 → warn
  const callees = new Set<string>();
  const callers = new Set<string>();
  for (const e of graph.edges) {
    const from = parseNodeId(e.from);
    const to = parseNodeId(e.to);
    if (from.kind === 'service' && to.kind === 'service') { callees.add(to.id); callers.add(from.id); }
    if (from.kind === 'service' && to.kind === 'infra') callers.add(from.id);
  }
  for (const id of graph.internal) {
    const n = byId.get(id);
    if (!n) continue;
    if (callees.has(id) || callers.has(id)) continue;
    if (n.roleSource === 'declared') continue;
    findings.push({
      rule: 'orphan-service',
      severity: 'warn',
      services: [id],
      message: `${id} 没有公网路由、没人调用它、它也不调用任何服务，画布上无法把它挂到任何关系里`,
      fix: '声明 cds.role（后台任务写 worker），或用 cds.calls / 环境变量引用说明它调用谁',
    });
  }

  // 5.5) cds.calls 指向不存在的服务（写错 / 已删除）→ warn：显式声明的边不能静默消失
  for (const u of graph.unresolvedCalls ?? []) {
    findings.push({
      rule: 'unknown-callee',
      severity: 'warn',
      services: [u.from],
      message: `${u.from} 的 cds.calls 声明调用 ${u.callee}，但 compose 里没有这个服务，这条关系不会出现在图上`,
      fix: `把 cds.calls 里的 ${u.callee} 改成真实服务名，或删掉这条声明`,
    });
  }

  // 6) 角色靠名字或默认推断 → info（合并成一条，避免 N 张只差主语的卡）
  const guessed = services.filter((n) => n.roleSource === 'name' || n.roleSource === 'default').map((n) => n.rawId).sort();
  if (guessed.length > 0) {
    findings.push({
      rule: 'role-by-name',
      severity: 'info',
      services: guessed,
      message: `${guessed.length} 个服务的角色靠服务名或默认值推断：${guessed.join('、')}`,
      fix: '给它们声明 cds.role: web / api / worker，声明后不再依赖名字',
    });
  }

  const order: Record<LintSeverity, number> = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.rule.localeCompare(b.rule) || a.services.join().localeCompare(b.services.join()));
  return {
    findings,
    summary: {
      errors: findings.filter((f) => f.severity === 'error').length,
      warnings: findings.filter((f) => f.severity === 'warn').length,
      infos: findings.filter((f) => f.severity === 'info').length,
    },
  };
}

/**
 * 从 compose 文本直接体检（导入审批 / cdscli verify / POST /api/compose/lint 共用）。
 * 解析失败返回 null（解析错误由各自的现有校验报，不在这里重复）。
 */
export function lintComposeYaml(composeYaml: string): TopologyLintReport | null {
  let parsed: ReturnType<typeof parseCdsCompose>;
  try {
    parsed = parseCdsCompose(composeYaml);
  } catch {
    return null;
  }
  if (!parsed) return null;
  // 解析产物还没归属项目（导入审批时才落到项目），体检只看结构，补一个占位 projectId 即可
  const profiles = parsed.buildProfiles.map((p) => ({ ...p, projectId: (p as { projectId?: string }).projectId || 'lint' }) as BuildProfile);
  const infra = parsed.infraServices.map((s) => ({ ...s, projectId: (s as { projectId?: string }).projectId || 'lint' }) as InfraService);
  const graph = buildServiceGraph(profiles, infra);
  return lintTopology(graph);
}
