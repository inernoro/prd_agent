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

export function resolveMapHomeHref(location: ConsoleLocation = window.location): string {
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
  base.searchParams.set('tutorialRoute', pathname);
  base.searchParams.set('tutorialLinks', '1');
  if (options.chapter) base.searchParams.set('entry', options.chapter);
  return base.toString();
}
