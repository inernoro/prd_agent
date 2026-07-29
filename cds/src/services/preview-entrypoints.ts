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

import { DNS_LABEL_MAX_LENGTH } from './preview-slug.js';
import { buildPreviewUrlForProject } from './comment-template.js';
import { resolveEffectiveProfile } from './container.js';
import type { StateService } from './state.js';
import type { BranchEntry } from '../types.js';

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

/** 命名子域的第一 DNS 标签。与 forwarder-route-publisher 的拼法一致。 */
export function namedServiceLabel(previewSlug: string, subdomain: string): string {
  return `${previewSlug}-${subdomain}`;
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
  for (const raw of opts.subdomains) {
    const sub = (raw || '').trim();
    if (!sub) continue;
    if (serviceUrls[sub]) continue; // first-wins,对齐发布端 writtenSubdomains 去重
    const label = namedServiceLabel(previewSlug, sub);
    if (!isPublishableNamedLabel(label)) continue; // 没发布就不声明
    serviceUrls[sub] = `https://${label}.${previewHost}`;
  }
  return { previewUrl: `https://${previewSlug}.${previewHost}`, serviceUrls };
}

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
): Record<string, string> {
  const project = deps.getProject(entry.projectId);
  const previewSlug = buildPreviewUrlForProject('', entry.branch, project, entry.projectId).previewSlug;
  const subdomains: string[] = [];
  for (const bp of deps.getEffectiveProfilesForBranch(entry)) {
    // 与发布端一致:必须应用 branch profileOverrides,否则覆写过 subdomain 的分支
    // 会声明出一个 forwarder 根本没发布的 host。
    const sub = (bp as { subdomain?: string }).subdomain;
    if (sub) subdomains.push(sub);
  }
  return publishedEntrypointsEnv(buildPublishedEntrypoints({
    previewSlug,
    previewHost: deps.previewHost,
    subdomains,
  }));
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
