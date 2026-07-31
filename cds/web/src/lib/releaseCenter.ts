export const DEFAULT_RELEASE_CENTER_PROJECT_ID = 'prd-agent';
export const DEFAULT_RELEASE_HEALTH_PATH = '/api/health';

const LAST_RELEASE_CENTER_PROJECT_KEY = 'cds:lastReleaseCenterProjectId';

export function releaseCenterHref(projectId?: string | null): string {
  const normalized = (projectId || '').trim();
  if (!normalized || normalized === DEFAULT_RELEASE_CENTER_PROJECT_ID) return '/release-center';
  return `/release-center?project=${encodeURIComponent(normalized)}`;
}

export function initialReleaseCenterProject(searchParams: URLSearchParams, storage?: Storage): string {
  const queryProject = searchParams.get('project')?.trim();
  if (queryProject) return queryProject;

  try {
    const remembered = storage?.getItem(LAST_RELEASE_CENTER_PROJECT_KEY)?.trim();
    if (remembered) return remembered;
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }

  return DEFAULT_RELEASE_CENTER_PROJECT_ID;
}

/**
 * 通知深链带过来的定位参数：`/release-center?project=X&target=Y&run=Z`。
 *
 * 站内信里那条「查看发布记录」承诺的是「打开出事的那个目标和那次发布」。
 * 页面此前只读 project，于是多目标时会落到默认目标、也不会打开被点名的 run——
 * 运维点开告警看到的是一屏无关内容，比不给链接更糟（Codex review P2，2026-07-29）。
 *
 * 只做解析不做校验：目标/发布是否存在由页面加载后判定，查不到就当没带参数，
 * 绝不因为一个过期 id 让整页停在空白。
 */
export function releaseCenterDeepLink(searchParams: URLSearchParams): {
  targetId?: string;
  runId?: string;
  branchId?: string;
  commitSha?: string;
} {
  const targetId = searchParams.get('target')?.trim();
  const runId = searchParams.get('run')?.trim();
  const branchId = searchParams.get('branch')?.trim();
  const commitSha = searchParams.get('commit')?.trim();
  return {
    ...(targetId ? { targetId } : {}),
    ...(runId ? { runId } : {}),
    ...(branchId ? { branchId } : {}),
    ...(commitSha ? { commitSha } : {}),
  };
}

export function rememberReleaseCenterProject(projectId: string, storage?: Storage): void {
  const normalized = projectId.trim();
  if (!normalized) return;
  try {
    storage?.setItem(LAST_RELEASE_CENTER_PROJECT_KEY, normalized);
  } catch {
    // Storage persistence is best-effort only.
  }
}

export function normalizeProductionOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return `${url.protocol}//${url.host}`;
  } catch {
    return candidate.replace(/\/+$/, '');
  }
}

export function buildReleaseHealthcheckUrl(
  publicUrl: string,
  healthPath: string,
  explicitHealthcheckUrl = '',
): string {
  if (explicitHealthcheckUrl.trim()) return explicitHealthcheckUrl.trim();
  const origin = normalizeProductionOrigin(publicUrl);
  if (!origin) return '';
  const path = healthPath.trim() || DEFAULT_RELEASE_HEALTH_PATH;
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}
