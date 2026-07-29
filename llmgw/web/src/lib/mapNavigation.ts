import { getRuntimeBasePath } from './runtimeBase';

type ConsoleLocation = Pick<Location, 'hostname' | 'protocol'>;

/**
 * 控制台子域的候选后缀。**长的排前面**，否则 `-llmgw` 会先把 `-llmgw-web` 削掉一半。
 *
 * 2026-07-29：子域从 `llmgw-web` 改名为 `llmgw`（它本来就是 web）。改名期间新旧
 * 两个 host 都会被平台发布（cds/src/services/preview-entrypoints.ts 的
 * LEGACY_SUBDOMAIN_ALIASES），所以这里必须两个都认——只认一个会让另一半用户
 * 点「返回 MAP」时落到控制台自己的根路径。
 *
 * 已知债务：这仍是一份「按 hostname 反推兄弟服务地址」的实现，与 MAP 侧刚刚拆掉的
 * 那份同源（doc/debt.platform.preview-entrypoints.md 的 PE-consumer-sweep）。
 * 正解是 console-api 把平台注入的 CDS_PREVIEW_URL 下发给 SPA，本文件只消费。
 * 在那之前，至少把「认哪些后缀」收敛成这一处，不再散落。
 */
const CONSOLE_SUBDOMAIN_SUFFIXES = ['-llmgw-web', '-llmgw'] as const;

/**
 * 平台下发的 MAP 主入口（`/gw/healthz` 的 mapHomeUrl，源头是 CDS 注入的 CDS_PREVIEW_URL）。
 *
 * 这才是权威值：谁部署的谁最清楚 MAP 在哪，不需要任何一方按 hostname 反推。
 * 拿到之前（首帧）与拿不到时（正式环境 / 非 CDS 托管）才走下面的后缀推算兜底。
 */
let platformMapHome: string | null = null;

/** 由 `getHealth()` 在拿到响应时调用；空值不覆盖已有的权威值。 */
export function setPlatformMapHome(url: string | null | undefined): void {
  const trimmed = (url ?? '').trim();
  if (!trimmed) return;
  platformMapHome = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/** 测试与调试用：清掉缓存的权威值，回到纯推算路径。 */
export function resetPlatformMapHome(): void {
  platformMapHome = null;
}

export function resolveMapHomeHref(location: ConsoleLocation = window.location): string {
  if (platformMapHome) return platformMapHome;
  if (location.hostname.endsWith('.ebcone.net') && location.hostname !== 'map.ebcone.net') {
    return `${location.protocol}//map.ebcone.net/`;
  }

  const firstDot = location.hostname.indexOf('.');
  if (firstDot < 0) return '/';

  const hostPrefix = location.hostname.slice(0, firstDot);
  const suffix = CONSOLE_SUBDOMAIN_SUFFIXES.find((candidate) => hostPrefix.endsWith(candidate));
  if (!suffix) return '/';

  const mapHost = `${hostPrefix.slice(0, -suffix.length)}${location.hostname.slice(firstDot)}`;
  return `${location.protocol}//${mapHost}/`;
}

/**
 * 能否打开 MAP 知识库里的《模型网关权威教程》。
 * 结构化入参而不是具体类型：本函数只关心这两个字段，避免为了一个判定把 auth 类型拖进来。
 */
export function canOpenTutorials(
  user: { identityProvider?: string } | null | undefined,
  tenant: { role?: string } | null | undefined,
): boolean {
  return user?.identityProvider === 'map' && (tenant?.role === 'owner' || tenant?.role === 'admin');
}

/**
 * 教程深链 SSOT。此前这段拼接内联在 ConsoleLayout 里，页面想外链教程只能抄一遍。
 *
 * `chapter` 落到 `?entry=`——与教程发布器的跨章节跳转用同一个参数（见 llmgw/tutorial/README.md），
 * 读者点进去直接停在那一章，而不是知识库首页。
 */
export function resolveTutorialHref(
  pathname: string,
  options: { chapter?: string } = {},
  location: ConsoleLocation & Pick<Location, 'href'> = window.location,
): string {
  const base = new URL(resolveMapHomeHref(location), location.href);
  base.pathname = `${base.pathname.replace(/\/$/, '')}/document-store`;
  base.searchParams.set('tutorialRoute', stripConsoleBase(pathname));
  base.searchParams.set('tutorialLinks', '1');
  // 章节用**独立参数**传，不能直接塞进 `entry`：`entry` 在知识库里是 Mongo 文档 id，
  // 而这里给的是教程 sourceId；何况 DocumentStorePage 解析 tutorialRoute 后会把 `entry`
  // 覆盖成该页第一篇教程，于是标着第 15 / 19 章的链接统统打开第一章（Codex P2）。
  // 由消费方按 sourceId 在解析结果里选出对应的 entryId。
  if (options.chapter) base.searchParams.set('tutorialSourceId', options.chapter);
  return base.toString();
}

/**
 * 去掉控制台自身的挂载前缀，还原成教程图谱登记的路由。
 *
 * 同源部署时控制台挂在 `/llmgw/` 下，`window.location.pathname` 是 `/llmgw/service-keys`，
 * 而图谱登记的是 `/service-keys` —— 直接传过去，MAP 那侧逐段比对必然不匹配，
 * 每个页面都返回「没有找到关联教程」（Codex P2，也正是现场那个提示的成因）。
 *
 * 幂等：调用方传的若已是 React Router 的 basename-stripped 路径（ConsoleLayout 走
 * useLocation），这里不会再削一次 —— 控制台没有名为 `/llmgw` 的路由。
 */
function stripConsoleBase(pathname: string): string {
  const base = getRuntimeBasePath();
  if (!base || !pathname.startsWith(base)) return pathname || '/';
  const stripped = pathname.slice(base.length);
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}
