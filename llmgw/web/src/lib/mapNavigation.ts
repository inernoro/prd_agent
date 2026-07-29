type ConsoleLocation = Pick<Location, 'hostname' | 'protocol'>;

export function resolveMapHomeHref(location: ConsoleLocation = window.location): string {
  if (location.hostname.endsWith('.ebcone.net') && location.hostname !== 'map.ebcone.net') {
    return `${location.protocol}//map.ebcone.net/`;
  }

  const firstDot = location.hostname.indexOf('.');
  if (firstDot < 0) return '/';

  const hostPrefix = location.hostname.slice(0, firstDot);
  const gatewaySuffix = '-llmgw-web';
  if (!hostPrefix.endsWith(gatewaySuffix)) return '/';

  const mapHost = `${hostPrefix.slice(0, -gatewaySuffix.length)}${location.hostname.slice(firstDot)}`;
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
