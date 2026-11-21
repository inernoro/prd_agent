import type { BranchEntry, BuildProfile, CdsConfig } from '../types.js';
import { buildPreviewUrlForProject } from './comment-template.js';
import { resolveEffectiveProfile } from './container.js';
import { isPublishableNamedLabel, namedServiceLabel, occupiedHostOwners } from './preview-entrypoints.js';
import { ROUTABLE_SERVICE_STATUSES } from './route-conventions.js';
import type { StateService } from './state.js';
import { handlesRootPath, mainDomainEntryPath, normalizeWebEntryPath, resolveWebEntry, selectPrimaryWebEntry } from './web-entry.js';

type BranchWebEntryState = Pick<StateService, 'getProject' | 'getAllBranches' | 'getEffectiveProfilesForBranch'>;

export function publicPreviewHost(config: Pick<CdsConfig, 'previewDomain' | 'rootDomains'>): string {
  return (config.previewDomain || config.rootDomains?.[0] || '').replace(/^https?:\/\//, '').replace(/\/+$/, '').trim();
}

/** The published browser entries shown on the branch list and in planning. */
export function computePublishedBranchWebEntries(
  stateService: BranchWebEntryState,
  entry: BranchEntry,
  primaryRoot: string,
): Array<{ name: string; url: string; serviceId?: string; subdomain?: string; primary: boolean }> {
  const project = stateService.getProject(entry.projectId);
  const previewSlug = buildPreviewUrlForProject('', entry.branch, project, entry.projectId).previewSlug;
  if (!previewSlug) return [];
  // 被已保存别名**或自定义域名**占走的 host，发布器不会写（那条路由指向别人的应用），
  // 面板与 GET /api/branches 也就不能把它当自己的入口列出来 —— 否则用户点开打开的是
  // 另一个分支的应用（Codex P1）。判据与发布器 / 入口表同用 occupiedHostOwners 一份，
  // 按**完整 host** 比（自定义域名存的是整条 host，只按标签判会漏）。
  const occupied = occupiedHostOwners(stateService.getAllBranches(), [primaryRoot]);
  const profileById = new Map<string, BuildProfile>();
  for (const bp of stateService.getEffectiveProfilesForBranch(entry)) {
    // resolveEffectiveProfile applies branch profileOverrides (subdomain / readinessProbe / …),
    // exactly like the publisher; without it override-driven landing paths would drift from the
    // route the forwarder actually serves.
    profileById.set(bp.id, resolveEffectiveProfile(bp, entry));
  }
  const effectiveProfiles = [...profileById.values()].filter((profile) =>
    resolveWebEntry(profile) !== null,
  );
  const primaryProfile = selectPrimaryWebEntry(effectiveProfiles);
  const primaryConfig = primaryProfile?.webEntry;
  const primaryPath = normalizeWebEntryPath(primaryConfig?.path) || '/';
  // 主入口 URL 必须按该 profile **真实的路由**拼，不能一律用主域名根：
  // 有 cds.subdomain 就走它的命名 host；挂在非根前缀就把入口路径挂到前缀下。
  // 否则显式 primary 的服务会指向承载根路径的另一个应用，而它自己那条能用的
  // URL 又被下面的命名子域循环跳过 —— 声明 primary 反而比不声明更糟（review P2-1）。
  const primarySub = primaryProfile?.subdomain;
  const primaryNamedLabel = primarySub ? namedServiceLabel(previewSlug, primarySub) : '';
  // 顺序要紧：承载 `/` 的主应用即使**也**声明了 cds.subdomain，它的用户入口依然是
  // 主域名（命名子域只是额外一条路由）。先判根路由再判子域，否则主应用会被挪到
  // `<slug>-admin.<root>`，而 branches.test.ts 的 dual-entry 用例正是钉这条。
  const primaryHandlesRoot = primaryProfile ? handlesRootPath(primaryProfile) : false;
  const primaryUsesNamedHost = !primaryHandlesRoot
    && Boolean(primarySub)
    && isPublishableNamedLabel(primaryNamedLabel)
    && !occupied.has(`${primaryNamedLabel}.${primaryRoot}`.toLowerCase());
  // 命名 host 上整条路由都指向该容器，入口路径原样用；主域名上则要带上它的挂载前缀。
  const primaryHost = primaryUsesNamedHost
    ? `${primaryNamedLabel}.${primaryRoot}`
    : `${previewSlug}.${primaryRoot}`;
  const primaryHostPath = primaryUsesNamedHost || !primaryProfile
    ? primaryPath
    : mainDomainEntryPath(primaryProfile, primaryPath);
  const primaryEntry = {
    name: primaryConfig?.name || '主应用入口',
    url: `https://${primaryHost}${primaryHostPath === '/' ? '' : primaryHostPath}`,
    ...(primaryProfile ? { serviceId: primaryProfile.id } : {}),
    ...(primaryUsesNamedHost && primarySub ? { subdomain: primarySub } : {}),
    primary: true,
  };
  const entries: Array<{ name: string; url: string; serviceId?: string; subdomain?: string; primary: boolean }> = [primaryEntry];
  // Collect routable services, sorted by profileId so first-wins dedup is deterministic across
  // object-key ordering changes (mirrors publisher's subdomainCandidates sort).
  const routable = Object.entries(entry.services ?? {})
    .filter(([, svc]) => svc?.hostPort && ROUTABLE_SERVICE_STATUSES.has(String(svc.status)))
    .map(([profileId]) => profileId)
    .sort((a, b) => a.localeCompare(b));
  const seenSubdomains = new Set<string>();
  // 主入口已经占用了这个命名 host，别的 profile 声明同名子域时不能再列一条同址入口。
  if (primaryUsesNamedHost && primarySub) seenSubdomains.add(primarySub);
  for (const profileId of routable) {
    const profile = profileById.get(profileId);
    const sub = profile?.subdomain;
    const webEntry = profile ? resolveWebEntry(profile) : null;
    const webPath = webEntry?.path || null;
    // 同一 profile 已由主域名承载时不再列命名子域，解决“主入口和第二项其实
    // 是同一个 Web 应用”的重复识别问题。
    if (!sub || !webEntry || !webPath || profileId === primaryProfile?.id) continue;
    if (seenSubdomains.has(sub)) continue;
    const namedLabel = namedServiceLabel(previewSlug, sub);
    // RFC 1035 single-label limit + wildcard cert coverage — shared predicate with the publisher
    // and the env-injected entrypoint table (preview-entrypoints.ts), so the three never drift.
    if (!isPublishableNamedLabel(namedLabel)) continue;
    if (occupied.has(`${namedLabel}.${primaryRoot}`.toLowerCase())) continue;
    seenSubdomains.add(sub);
    entries.push({
      subdomain: sub,
      serviceId: profileId,
      name: webEntry.name,
      url: `https://${namedLabel}.${primaryRoot}${webPath === '/' ? '' : webPath}`,
      primary: false,
    });
  }
  return entries;
}
