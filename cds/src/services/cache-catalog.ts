/** Compiler-cache destinations and legacy declaration retirement are a shared catalog.
 * Ordinary source builds use their container writable layer. Persistent warm caches
 * require explicit fresh profile storage; no producer regenerates host bindings.
 */

import type { CacheMount } from '../types.js';
import {normalizeCacheHostPath} from './cache-paths.js';

/**
 * dockerImage 名里命中的子串 → 该栈应当挂载的缓存目录（containerPath）。
 *
 * 命中规则：image 字符串包含 key（小写匹配）即视为该栈。key 顺序无所谓，
 * 一个 image 可能命中多条（极少见，按需全挂）。containerPath 是容器内的
 * 依赖缓存目录；hostSubdir 只识别历史系统声明及显式新分配请求，不再生成宿主挂载。
 */
interface CacheCatalogEntry {
  /** dockerImage 里命中的子串（全部小写比较）。 */
  imageMatch: string[];
  /** cacheBase 下的子目录名（host 端，多栈隔离避免互相污染）。 */
  hostSubdir: string;
  /** 容器内依赖缓存目录。 */
  containerPath: string;
}

/**
 * 缓存目录目录表。新增语言/包管理器只加一行。
 *
 * 已覆盖：
 *   - node   → pnpm store
 *   - dotnet → nuget packages
 *   - java   → Maven .m2 + Gradle .gradle（用户痛点：任务 3）
 *   - go     → GOPATH pkg/mod
 *   - rust   → cargo registry
 *   - python → pip cache
 */
export const CACHE_CATALOG: CacheCatalogEntry[] = [
  { imageMatch: ['node'], hostSubdir: 'pnpm', containerPath: '/pnpm/store' },
  { imageMatch: ['dotnet'], hostSubdir: 'nuget', containerPath: '/root/.nuget/packages' },
  // Java：Maven 与 Gradle 都挂，detectJava 可能产出任一构建工具，
  // 而 dockerImage 都是 eclipse-temurin / jdk，无法从 image 区分工具链，
  // 故两个缓存目录都挂上（不存在的那个空挂载无害）。
  { imageMatch: ['temurin', 'jdk', 'jre', 'openjdk', 'maven', 'gradle'], hostSubdir: 'm2', containerPath: '/root/.m2' },
  { imageMatch: ['temurin', 'jdk', 'jre', 'openjdk', 'maven', 'gradle'], hostSubdir: 'gradle', containerPath: '/root/.gradle' },
  { imageMatch: ['golang', 'go:'], hostSubdir: 'gomod', containerPath: '/go/pkg/mod' },
  { imageMatch: ['rust', 'cargo'], hostSubdir: 'cargo', containerPath: '/usr/local/cargo/registry' },
  { imageMatch: ['python'], hostSubdir: 'pip', containerPath: '/root/.cache/pip' },
];

/** Compiler caches default to the container writable layer. Recreate is cold.
 * This compatibility function must never allocate or regenerate host binds.
 * Durable fresh caches require the explicit branch/profile storage P API.
 */
export function buildCacheMounts(_image: string, _cacheBase: string): CacheMount[] { return []; }

/** Requests for explicit new-only profile P; no host path or runtime allocation. */
export function catalogFreshCacheRequests(image: string): Array<{mountKey: string; containerPath: string; purpose: 'cache'}> {
  const seen = new Set<string>();
  return CACHE_CATALOG.filter(entry => entry.imageMatch.some(key => image.toLowerCase().includes(key)))
    .filter(entry => { if (seen.has(entry.containerPath)) return false; seen.add(entry.containerPath); return true; })
    .map(entry => ({mountKey: entry.hostSubdir, containerPath: entry.containerPath, purpose: 'cache'}));
}

const LEGACY_NODE_EXTRA: CacheCatalogEntry[] = [
  { imageMatch: ['node'], hostSubdir: 'yarn', containerPath: '/usr/local/share/.cache/yarn' },
  { imageMatch: ['node'], hostSubdir: 'npm', containerPath: '/root/.npm' },
];

/** Retire only exact legacy CDS compiler-cache declarations. No filesystem access,
 * adoption, movement or deletion. Explicit/unknown user binds remain rejected by R.
 * Preserve each original declaration in profile.retiredCatalogCacheMounts.
 */
export function retireGeneratedCatalogCaches(image: string, cacheBase: string, mounts: CacheMount[]) {
  const lower = (image || '').toLowerCase();
  const catalog = [...CACHE_CATALOG, ...LEGACY_NODE_EXTRA].filter(e => e.imageMatch.some(m => lower.includes(m)));
  const kept: CacheMount[] = [], retired: CacheMount[] = [];
  for (const mount of mounts) {
    const target = mount.containerPath === '/root/.local/share/pnpm/store' ? '/pnpm/store' : mount.containerPath;
    const generated = mount.kind === undefined && mount.storage === undefined && mount.readOnly === undefined
      && catalog.some(e => normalizeCacheHostPath(mount.hostPath, cacheBase) === `${cacheBase}/${e.hostSubdir}` && target === e.containerPath);
    (generated ? retired : kept).push({ ...mount });
  }
  return { kept, retired };
}

export function mergeRetiredCatalogCaches(previous: CacheMount[], next: CacheMount[]): CacheMount[] {
  const seen = new Set<string>();
  return [...previous, ...next].filter(mount => {
    const key = JSON.stringify(mount);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(mount => ({ ...mount }));
}
