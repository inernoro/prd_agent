import { readPublicDeploymentConfig } from '@/lib/runtimeConfig';

export type FrontEndProjectKind = 'miniapp' | 'admin' | 'h5' | 'static' | 'legacy' | 'site';

export interface FrontEndProjectEntry {
  name: string;
  kind: FrontEndProjectKind;
  tech: string;
  codingUrl?: string;
  githubUrl?: string;
  svnUrl?: string;
  docUrl?: string;
  buildUrl?: string;
  localUrl?: string;
  branches?: string;
  release?: string;
  notes?: string;
  tags: string[];
}

const PROJECT_KINDS = new Set<FrontEndProjectKind>([
  'miniapp', 'admin', 'h5', 'static', 'legacy', 'site',
]);

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseProjectEntry(value: unknown): FrontEndProjectEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const name = normalizeOptionalText(raw.name);
  const tech = normalizeOptionalText(raw.tech);
  const kind = normalizeOptionalText(raw.kind) as FrontEndProjectKind | undefined;
  if (!name || !tech || !kind || !PROJECT_KINDS.has(kind)) return null;

  return {
    name,
    tech,
    kind,
    codingUrl: normalizeOptionalText(raw.codingUrl),
    githubUrl: normalizeOptionalText(raw.githubUrl),
    svnUrl: normalizeOptionalText(raw.svnUrl),
    docUrl: normalizeOptionalText(raw.docUrl),
    buildUrl: normalizeOptionalText(raw.buildUrl),
    localUrl: normalizeOptionalText(raw.localUrl),
    branches: normalizeOptionalText(raw.branches),
    release: normalizeOptionalText(raw.release),
    notes: normalizeOptionalText(raw.notes),
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((tag): tag is string => typeof tag === 'string' && Boolean(tag.trim())).map((tag) => tag.trim())
      : [],
  };
}

export function parseFrontEndProjectRegistry(raw: string | undefined): FrontEndProjectEntry[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseProjectEntry).filter((item): item is FrontEndProjectEntry => item !== null);
  } catch {
    return [];
  }
}

/**
 * 项目目录属于部署数据，不进入源码。CDS/正式发布在构建时注入 JSON；未配置时安全显示空目录。
 */
export const FRONT_END_PROJECTS = parseFrontEndProjectRegistry(
  readPublicDeploymentConfig('VITE_FRONT_END_PROJECT_REGISTRY_JSON'),
);

export const FRONT_END_PROJECT_KIND_LABEL: Record<FrontEndProjectKind, string> = {
  miniapp: '小程序',
  admin: '后台',
  h5: 'H5',
  static: '静态站',
  legacy: '旧项目',
  site: '站点',
};
