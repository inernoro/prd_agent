/**
 * 配置字段三级权威模型（Config Field Authority）—— 2026-05-29
 *
 * 用户洞察：「每个东西限制什么、不限制什么，这很重要」。CDS 过去把整份
 * cds-compose.yml 当黑箱，任何人（agent / 用户 / 平台）都能改任意字段，
 * 改完没人知道边界在哪 —— 这正是「别人配不对」的根源。
 *
 * 本模块给 cds-compose.yml 的每个字段标注「谁说了算」：
 *
 * - repo     代码权威：构建/启动方式由仓库结构决定（workDir / command /
 *            image / entrypoint / healthcheck）。agent 可以改（它最懂 repo
 *            结构变更），但改完**应回写 repo**，否则又漂移。
 * - platform 平台权威：CDS 自己分配/管理（hostPort / dockerNetwork / 域名 /
 *            containerName / 副本编排）。agent 和用户**只读**，强写拒绝。
 * - user     用户权威：环境变量、副本数等运营参数。用户可覆盖，agent 可建议。
 *
 * 这张表是 SSOT。`validateComposePatch` 在 PUT /compose 和未来的
 * `cds-config` 技能写回时强制校验：platform 字段被改动一律 reject 并回报
 * 违规清单，让调用方明确「这个字段不归你管」。
 */

export type FieldAuthority = 'repo' | 'platform' | 'user';

export interface FieldAuthorityEntry {
  authority: FieldAuthority;
  /** 给 UI / 技能展示「为什么是这个权威」。 */
  reason: string;
}

/**
 * cds-compose.yml 顶层及 service 级字段的权威映射。
 *
 * key 用「点路径」描述字段位置，`*` 匹配 service 名这一层：
 *   services.*.build.workDir        → repo
 *   services.*.ports                → platform（CDS 重新分配 hostPort）
 *   services.*.environment          → user
 *
 * 查询时 `classifyComposeField` 会把具体路径（如
 * `services.imp-api.build.command`）归一到带 `*` 的模式再查表。
 */
export const COMPOSE_FIELD_AUTHORITY: Record<string, FieldAuthorityEntry> = {
  // ---- repo 权威：构建/启动方式，由仓库结构决定 ----
  'services.*.build.workDir': { authority: 'repo', reason: '构建工作目录由仓库结构决定，repo 重构后须同步' },
  'services.*.build.command': { authority: 'repo', reason: '构建/启动命令由仓库脚本决定' },
  'services.*.build.dockerfile': { authority: 'repo', reason: 'Dockerfile 路径由仓库决定' },
  'services.*.image': { authority: 'repo', reason: '基础镜像由项目技术栈决定' },
  'services.*.command': { authority: 'repo', reason: '容器启动命令由应用决定' },
  'services.*.entrypoint': { authority: 'repo', reason: '入口由应用决定' },
  'services.*.healthcheck': { authority: 'repo', reason: '健康检查由应用语义决定' },
  'services.*.depends_on': { authority: 'repo', reason: '服务依赖关系由应用拓扑决定' },

  // ---- platform 权威：CDS 分配/管理，只读 ----
  'services.*.ports': { authority: 'platform', reason: 'CDS 自动分配宿主机端口，避免多分支冲突' },
  'services.*.container_name': { authority: 'platform', reason: '容器名由 CDS 按 分支-服务 规则生成' },
  'services.*.networks': { authority: 'platform', reason: 'Docker 网络由 CDS 按项目隔离分配' },
  'networks': { authority: 'platform', reason: '网络拓扑由 CDS 统一管理' },
  'x-cds-domain': { authority: 'platform', reason: '预览域名由 CDS slug 公式生成' },
  'services.*.deploy.replicas': { authority: 'platform', reason: '副本编排由 CDS 调度（当前 placeholder）' },

  // ---- user 权威：运营参数，用户可覆盖 ----
  'services.*.environment': { authority: 'user', reason: '环境变量由用户/项目维护，agent 仅建议' },
  'services.*.volumes': { authority: 'user', reason: '数据卷挂载关系到用户数据持久化' },
};

/** 路径中 service 名那一段会被归一成 `*` 再查表。 */
function normalizePath(path: string): string {
  const segs = path.split('.');
  // services.<name>.xxx → services.*.xxx
  if (segs[0] === 'services' && segs.length >= 2) {
    segs[1] = '*';
  }
  return segs.join('.');
}

/**
 * 判定一个字段路径属于哪个权威。未登记的字段默认 `user`（最宽松，
 * 不阻断），但带 `known:false` 让调用方知道这是表外字段。
 */
export function classifyComposeField(path: string): FieldAuthorityEntry & { known: boolean } {
  const normalized = normalizePath(path);
  const hit = COMPOSE_FIELD_AUTHORITY[normalized];
  if (hit) return { ...hit, known: true };
  // 顶层精确兜底
  const top = COMPOSE_FIELD_AUTHORITY[path];
  if (top) return { ...top, known: true };
  // Codex review(PR #684):叶子路径继承最近已登记祖先的权威。权威表混了粒度
  // —— 顶层整键(networks / x-cds-domain)、服务级整字段(services.*.ports)、
  // 嵌套叶子(services.*.deploy.replicas)。diff 现在递归到叶子(networks.cds-net.driver
  // / services.api.deploy.replicas 等),若不向上匹配,改 networks 子键就会被当未登记
  // user 字段放行,绕过 platform 权威。这里从最具体往上逐级 prefix 查表,命中即返回
  // (最近祖先优先),保证任何 platform 子树下的改动都被正确判为 platform。
  const segs = path.split('.');
  for (let len = segs.length - 1; len >= 1; len -= 1) {
    const prefix = segs.slice(0, len).join('.');
    const ancestor = COMPOSE_FIELD_AUTHORITY[normalizePath(prefix)] || COMPOSE_FIELD_AUTHORITY[prefix];
    if (ancestor) return { ...ancestor, known: true };
  }
  return { authority: 'user', reason: '未登记字段，默认按用户权威处理', known: false };
}

export interface ComposePatchViolation {
  path: string;
  authority: FieldAuthority;
  reason: string;
}

export interface ComposePatchValidation {
  ok: boolean;
  /** 被改动但调用方无权改的字段（platform 权威 + 调用方非 platform）。 */
  violations: ComposePatchViolation[];
}

/**
 * 校验一组「被改动的字段路径」对给定调用方是否合法。
 *
 * @param changedPaths 本次 patch 改动的字段点路径列表
 * @param actor 调用方：'agent' / 'user' / 'platform'
 *
 * 规则：
 * - platform 权威字段：只有 actor='platform'（CDS 内部）能改，其余 reject
 * - repo / user 权威字段：agent 和 user 都能改
 *
 * 返回违规清单而非抛错，让调用方一次性看到所有越界字段。
 */
export function validateComposePatch(
  changedPaths: string[],
  actor: 'agent' | 'user' | 'platform',
): ComposePatchValidation {
  if (actor === 'platform') return { ok: true, violations: [] };
  const violations: ComposePatchViolation[] = [];
  for (const path of changedPaths) {
    const cls = classifyComposeField(path);
    if (cls.authority === 'platform') {
      violations.push({ path, authority: 'platform', reason: cls.reason });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * 给一份解析后的 compose 对象，浅层遍历产出「字段路径 → 权威」标注表，
 * 供面板渲染三色图例 + 技能预览「我能改哪些」。只下钻到 service 级常见
 * 字段，不做深递归（够 UI 用）。
 */
export function annotateComposeAuthority(
  parsed: { services?: Record<string, Record<string, unknown>> } | null | undefined,
): Array<{ path: string; authority: FieldAuthority; reason: string; known: boolean }> {
  const out: Array<{ path: string; authority: FieldAuthority; reason: string; known: boolean }> = [];
  if (!parsed || !parsed.services) return out;
  for (const [svcName, svc] of Object.entries(parsed.services)) {
    if (!svc || typeof svc !== 'object') continue;
    for (const field of Object.keys(svc)) {
      const path = `services.${svcName}.${field}`;
      const cls = classifyComposeField(path);
      out.push({ path, authority: cls.authority, reason: cls.reason, known: cls.known });
    }
  }
  return out;
}
