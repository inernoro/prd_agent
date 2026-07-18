export function getRuntimeBasePath(pathname?: string): string {
  const currentPath = pathname ?? (typeof window === 'undefined' ? '/' : window.location.pathname);
  return currentPath === '/llmgw' || currentPath.startsWith('/llmgw/') ? '/llmgw' : '';
}

export function getRouterBasename(pathname?: string): string | undefined {
  return getRuntimeBasePath(pathname) || undefined;
}

export function getDefaultApiBase(pathname?: string): string {
  return `${getRuntimeBasePath(pathname)}/gw`;
}
