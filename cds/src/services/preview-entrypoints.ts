/*
 * preview-entrypoints — 「这个分支在公网上到底发布了哪几个入口」的唯一判据。
 *
 * 背景(2026-07-29):MAP 前端此前自己在浏览器里拼网关子域 ——
 *   `${location.hostname 去掉 .miduo.org}` + `-llmgw-web` + `.miduo.org`
 * 这是 CDS 之外的第二份域名推算实现,违反根 CLAUDE.md 规则 #11(禁止自己 slugify /
 * 拼域名)。它拼出来的 host 有两种偏差:
 *   ① 分支名长时 `<previewSlug>-<sub>` 超过 63 octet,CDS 根本没发布这条路由,
 *      前端却照拼 → 用户点开拿到「域名不存在」,而错误提示说的是「登录凭据未通过安全校验」;
 *   ② 将来 CDS 改了命名规则(v3 → v4),前端不会跟着变。
 *
 * 解法不是让前端拼得更准,而是**取消前端的推算权**:CDS 在部署时把「已发布入口表」
 * 注入容器 env,应用侧只消费不推算。本模块就是那张表的计算 SSOT。
 *
 * 判据与 forwarder-route-publisher(真正写路由的地方)保持一字不差:
 * 命名子域的第一 DNS 标签 `<previewSlug>-<sub>` 必须 ≤ DNS_LABEL_MAX_LENGTH,
 * 超出则**不发布**(不截断、不哈希 —— 截断会丢唯一性、可能与别的 slug 撞 host)。
 * 因此「表里没有这一项」= 「这个环境确实没有这个入口」,是可声明的缺席,
 * 而不是让消费方去猜(no-rootless-tree:不假定不存在的能力)。
 *
 * 纯函数,不读 state、不碰 docker,可直接单测。
 */

import crypto from 'node:crypto';
import { DNS_LABEL_MAX_LENGTH } from './preview-slug.js';
import { buildPreviewUrlForProject } from './comment-template.js';
import { resolveEffectiveProfile } from './container.js';
import type { StateService } from './state.js';
import type { BranchEntry } from '../types.js';
import type { PublishedEntrypointsEnv } from './env-provenance.js';

/** 容器 env 里承载「本分支主入口」的 key。 */
export const PREVIEW_URL_ENV_KEY = 'CDS_PREVIEW_URL';
/** 容器 env 里承载「本分支全部命名服务入口」的 key,值为 JSON 对象字符串。 */
export const SERVICE_URLS_ENV_KEY = 'CDS_SERVICE_URLS';

export interface PublishedEntrypoints {
  /** 分支主入口 `https://<previewSlug>.<host>`;previewSlug/host 缺失时为 undefined。 */
  previewUrl?: string;
  /** subdomain → 完整 URL。只包含**确实会被发布**的命名入口(标签 ≤63)。 */
  serviceUrls: Record<string, string>;
}

const LABEL_HASH_LENGTH = 8;

/**
 * 截断 slug 到给定预算，**只在 `-` 分段边界下刀**。
 *
 * 为什么不能按字符硬切：slug 是人读的（`llmgw-self-service-...-claude-prd-agent`），
 * 硬切会切出 `...-cla` 这种半个词的残根 —— 用户看一眼记不住、也拼不出来。
 * 按段丢弃则每一段都是完整单词，截出来的仍然念得出、抄得对。
 *
 * 兜底：第一段就超预算时（罕见，如无连字符的超长 slug）才退回字符硬切，
 * 否则会返回空串导致 host 里出现 `--`。
 */
function truncateSlugAtSegmentBoundary(slug: string, budget: number): string {
  if (slug.length <= budget) return slug;
  let head = '';
  for (const segment of slug.split('-')) {
    if (!segment) continue;
    const next = head ? `${head}-${segment}` : segment;
    if (next.length > budget) break;
    head = next;
  }
  if (head) return head;
  const sliced = slug.slice(0, budget);
  return sliced.replace(/-+$/g, '') || sliced;
}

/**
 * 命名子域的第一 DNS 标签。**唯一拼法** —— 发布器、入口表、网关 URL 计算、
 * 两处 SSRF 白名单全部走这里，任何一处自己拼都会与实际发布的 host 漂移。
 *
 * 超过 63 octet 时按 `-` 分段截断 slug 并接一段 sha1 摘要，让长分支也拿得到命名入口。
 * 为什么必须带摘要：段截断照样会丢唯一性 —— 两个前几段相同的长分支会塌成同一个
 * host、互相抢路由（发布器早年因此宁可跳过不发布）。摘要取自完整 previewSlug，
 * 所以同一分支的所有服务共享同一段 `<head>-<hash>` 前缀，肉眼可归组。
 *
 * 纯函数、确定性：同样的输入永远得到同样的 host，解析侧照旧「重算再比」即可。
 */
export function namedServiceLabel(previewSlug: string, subdomain: string): string {
  const label = `${previewSlug}-${subdomain}`;
  if (label.length <= DNS_LABEL_MAX_LENGTH) return label;

  const suffix = `-${subdomain}`;
  // 预留 `-<8 位摘要>` 与 `-<subdomain>`，剩下的才是 slug 头部能占的位置。
  const headBudget = DNS_LABEL_MAX_LENGTH - suffix.length - LABEL_HASH_LENGTH - 1;
  // subdomain 自己就长到压不下来 —— 截无可截，原样返回让 isPublishableNamedLabel 拦下。
  if (headBudget <= 0) return label;

  const hash = crypto.createHash('sha1').update(previewSlug).digest('hex').slice(0, LABEL_HASH_LENGTH);
  return `${truncateSlugAtSegmentBoundary(previewSlug, headBudget)}-${hash}${suffix}`;
}

/**
 * 改名后仍要继续解析的历史子域。
 *
 * 2026-07-29：模型网关控制台的子域从 `llmgw-web` 改名为 `llmgw`（它本来就是 web，
 * `-web` 是废字）。但**别的分支正挂在旧地址上**，直接改名会让那些链接一起失效。
 * 所以发布器对每个规范子域**同时发布它的历史别名**，旧 host 照常可达；
 * 面板只展示规范名，不制造重复条目。
 *
 * 别名什么时候能删：确认没有存量链接/文档还指着旧名之后，从这里去掉即可，
 * 判据不散落在别处。
 */
export const LEGACY_SUBDOMAIN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  llmgw: ['llmgw-web'],
};

/** 某个规范子域实际要发布的全部名字：规范名在前，历史别名在后。 */
export function subdomainWithLegacyAliases(subdomain: string): string[] {
  const legacy = LEGACY_SUBDOMAIN_ALIASES[subdomain] ?? [];
  // 存量 profile 可能仍写着历史名（compose 未重新导入），此时它自己就是规范名，
  // 不再展开别名，避免同一个名字发两遍。
  return [subdomain, ...legacy.filter((name) => name !== subdomain)];
}

/**
 * 一个 profile 的 subdomain **实际会被发布出去的全部第一 DNS 标签**（含历史别名，已过发布判据）。
 *
 * 这是「发布了哪些 host」的唯一枚举口径。凡是要跟发布结果对齐的地方都必须走它：
 * 发布器本身、跨分支撞名检查、两处 SSRF 白名单。
 *
 * 为什么单列出来：2026-07-29 加历史别名时只接了发布器一处，另外三处仍只算规范名，
 * 于是 ① 别的分支可以把别名 host 当自己的子域别名占走而撞名检查发现不了；
 * ② 探测/压测打自己发布的别名 host 会被自家 SSRF 闸 403 挡掉。
 * 这正是 `.claude/rules/predicate-and-wiring-discipline.md` 形状 3（判据分裂）。
 */
export function publishedServiceLabels(previewSlug: string, subdomain: string): string[] {
  return subdomainWithLegacyAliases(subdomain)
    .map((name) => namedServiceLabel(previewSlug, name))
    .filter(isPublishableNamedLabel);
}

/**
 * 这个第一标签能不能作为命名子域发布。
 *
 * 超过 RFC 1035 单标签上限时:既无法可靠解析,单标签通配证书 `*.<root>` 也不覆盖。
 * forwarder-route-publisher / computeBranchGatewayUrls / 本模块共用这一条判据。
 */
export function isPublishableNamedLabel(label: string): boolean {
  return label.length <= DNS_LABEL_MAX_LENGTH;
}

/**
 * 算出注入容器的已发布入口表。
 *
 * @param previewSlug 由 computePreviewSlug 产出的分支 slug(不在这里重算)
 * @param previewHost 公开的 previewDomain(不带协议)。缺失则整张表为空 —— 宁可
 *                    什么都不声明,也不声明一个猜的地址。
 * @param subdomains  本分支**已应用 branch override** 的 profile.subdomain 列表。
 *                    顺序即优先级:同名 subdomain 取第一个(与发布端 first-wins 一致)。
 */
export function buildPublishedEntrypoints(opts: {
  previewSlug?: string;
  previewHost?: string;
  subdomains: readonly string[];
}): PublishedEntrypoints {
  const previewSlug = (opts.previewSlug || '').trim();
  const previewHost = (opts.previewHost || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .trim();
  if (!previewSlug || !previewHost) return { serviceUrls: {} };

  const serviceUrls: Record<string, string> = {};
  const declare = (name: string): void => {
    if (serviceUrls[name]) return;
    const label = namedServiceLabel(previewSlug, name);
    if (!isPublishableNamedLabel(label)) return; // 没发布就不声明
    serviceUrls[name] = `https://${label}.${previewHost}`;
  };
  // 表里要**逐条对应发布器实际写出的路由**，历史别名同样在列 —— 否则会出现
  // 「路由发布了但表里没有」，消费方据表判定就会误报「本环境没有这个入口」。
  //
  // 与发布器同款两趟：先全部规范名，再补别名。同一分支里一个 profile 声明 `llmgw`、
  // 另一个声明 `llmgw-web` 时，后者的**显式声明**必须压过前者展开出的兼容别名，
  // 否则表与实际发布的归属相反（Codex P1）。
  const subs = opts.subdomains.map((raw) => (raw || '').trim()).filter(Boolean);
  for (const sub of subs) declare(sub);
  for (const sub of subs) for (const name of subdomainWithLegacyAliases(sub)) declare(name);
  return { previewUrl: `https://${previewSlug}.${previewHost}`, serviceUrls };
}

/**
 * 命名子域入口在面板上该落到哪个路径。
 *
 * **判据是 profile 自己声明的就绪路径，不是子域的名字。** 就绪路径是该服务对
 * 「我哪个路径是活的」的第一手声明，也是唯一不依赖命名约定的信号：API-only 的服务
 * 声明 `/gw/healthz`，SPA 声明 `/`，落点直接照抄即可。
 *
 * 此前反过来——先查一张写死的名字表、就绪路径只做兜底。于是 2026-07-29 把 `llmgw`
 * 从「后端 API」改名成「控制台」时，表里那一行被整个改判成落 `/`，所有仍把 `llmgw`
 * 当 API 子域用的存量项目跟着遭殃：它们的服务在根路径 404，而面板链接指的正是根路径，
 * 且此前显式写出的 `/gw/healthz` 被名字表压掉、连兜底都轮不上（Codex P2）。
 * 这就是「改了机制没回头看依赖它的东西」——名字表是全局共享的，改一行等于替所有项目改。
 *
 * 名字表因此降级为兜底，只服务「声明了子域却没声明就绪路径」的 profile。
 */
export function resolveServiceLandingPath(subdomain: string, readinessPath?: string): string {
  const declared = (readinessPath ?? '').trim();
  if (declared.startsWith('/')) return declared;
  const sub = (subdomain || '').trim().toLowerCase();
  // 控制台是 Vite SPA，nginx 对任何非 /gw/* 路径回落 index.html，落根即进登录页。
  // `llmgw` 是 2026-07-29 起的规范名，`llmgw-web` 是发布器继续服务的历史别名。
  if (sub === 'llmgw' || sub === 'llmgw-web') return '/';
  // serving 引擎 API-only，挂在 /gw/v1/* 下，裸根 404。
  if (sub === 'llmgw-serve') return '/gw/v1/healthz';
  return '/';
}

/**
 * 平台独占的 env key。项目 / profile 在这些 key 上写什么都不算数 ——
 * 注入前会先被清掉（见 env-provenance 第 4.6 层）。表为空时更要清:
 * 那正是「CDS 说这里没有这条路由」，项目却留着一个地址才最危险。
 */
export const RESERVED_ENTRYPOINT_ENV_KEYS = [PREVIEW_URL_ENV_KEY, SERVICE_URLS_ENV_KEY] as const;

/** 把入口表转成注入容器的 env 片段。表为空则不注入任何 key(不写空串占位)。 */
export function publishedEntrypointsEnv(entrypoints: PublishedEntrypoints): Record<string, string> {
  const env: Record<string, string> = {};
  if (entrypoints.previewUrl) env[PREVIEW_URL_ENV_KEY] = entrypoints.previewUrl;
  if (Object.keys(entrypoints.serviceUrls).length > 0) {
    env[SERVICE_URLS_ENV_KEY] = JSON.stringify(entrypoints.serviceUrls);
  }
  return env;
}

/** 组装入口表所需的最小依赖(结构化,便于单测替身)。 */
export interface BranchEntrypointDeps {
  /** 公开的 previewDomain(不带协议)。缺失则不声明任何入口。 */
  previewHost?: string;
  getProject(projectId: string): { slug?: string; name?: string } | undefined;
  getEffectiveProfilesForBranch(entry: BranchEntry): Array<{ subdomain?: string }>;
}

/**
 * 单一组装入口:部署路径(container 注入)与 effective-env 检查器端点都走这里,
 * 保证「检查器看到的」=「部署实际注入的」。
 *
 * 用 **已声明的拓扑**(build profile 的 subdomain)而不是运行时服务状态 ——
 * 首次部署时兄弟容器还没起来,按运行时状态算会得到一张空表,应用会误判成
 * 「本环境没有网关」。声明层是部署时就确定的,不受启动顺序影响。
 */
export function resolveBranchEntrypointsEnv(
  entry: BranchEntry,
  deps: BranchEntrypointDeps,
): PublishedEntrypointsEnv {
  const project = deps.getProject(entry.projectId);
  const previewSlug = buildPreviewUrlForProject('', entry.branch, project, entry.projectId).previewSlug;
  const subdomains: string[] = [];
  for (const bp of deps.getEffectiveProfilesForBranch(entry)) {
    // 与发布端一致:必须应用 branch profileOverrides,否则覆写过 subdomain 的分支
    // 会声明出一个 forwarder 根本没发布的 host。
    const sub = (bp as { subdomain?: string }).subdomain;
    if (sub) subdomains.push(sub);
  }
  return {
    reservedKeys: RESERVED_ENTRYPOINT_ENV_KEYS,
    env: publishedEntrypointsEnv(buildPublishedEntrypoints({
      previewSlug,
      previewHost: deps.previewHost,
      subdomains,
    })),
  };
}

/** 从 StateService 造 deps —— 唯一一处知道「effective profile 要过 resolveEffectiveProfile」。 */
export function branchEntrypointDepsFromState(
  stateService: Pick<StateService, 'getProject' | 'getEffectiveProfilesForBranch'>,
  previewHost?: string,
): BranchEntrypointDeps {
  return {
    previewHost,
    getProject: (projectId) => stateService.getProject(projectId),
    getEffectiveProfilesForBranch: (entry) =>
      stateService.getEffectiveProfilesForBranch(entry).map((bp) => resolveEffectiveProfile(bp, entry)),
  };
}
