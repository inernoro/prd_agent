/**
 * 构建依赖缓存挂载目录的单一数据源（SSOT）。
 *
 * 2026-06-20 引入。病根：原来"按 dockerImage 推断要挂哪个依赖缓存"的逻辑
 * 抄了两份且都只覆盖 node / dotnet：
 *   1. routes/projects.ts 的 defaultCacheMountsFor()
 *   2. services/state.ts 的 migrateCacheMounts() IMAGE_CACHE_MAP
 *
 * 后果（用户反馈，任务 3）：Java 项目每次起容器都重新 `mvn dependency:resolve`
 * / `gradlew` 把整棵依赖树从 Maven Central 冷下载一遍——因为 `.m2` / `.gradle`
 * 没有任何 named 缓存挂载，构建动辄 >10 分钟。Go / Rust / Python 同病。
 *
 * 这里把映射收敛到一处：新增栈只改这一个文件，两个调用点自动对齐。挂载点
 * 用容器内 root 主目录约定路径（CDS 容器默认以 root 跑，见
 * container.ts buildProfileVolumeFlags），覆盖各生态默认的依赖缓存目录。
 *
 * 纯函数 / 无副作用 / 无网络 —— 可被任何 route / service / 测试直接调用。
 */

import type { CacheMount } from '../types.js';

/**
 * dockerImage 名里命中的子串 → 该栈应当挂载的缓存目录（containerPath）。
 *
 * 命中规则：image 字符串包含 key（小写匹配）即视为该栈。key 顺序无所谓，
 * 一个 image 可能命中多条（极少见，按需全挂）。containerPath 是容器内的
 * 依赖缓存目录；hostPath 由调用方用 cacheBase 拼前缀（见 buildCacheMounts）。
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

/**
 * 按 dockerImage 推断应挂载的依赖缓存目录。命中的每个 catalog entry 产出一条
 * CacheMount（hostPath = `${cacheBase}/${hostSubdir}`）。无命中返回空数组。
 *
 * 去重以 containerPath 为键，避免同一目录被挂两次。
 */
export function buildCacheMounts(image: string, cacheBase: string): CacheMount[] {
  const lower = (image || '').toLowerCase();
  const seen = new Set<string>();
  const mounts: CacheMount[] = [];
  for (const entry of CACHE_CATALOG) {
    if (!entry.imageMatch.some((m) => lower.includes(m))) continue;
    if (seen.has(entry.containerPath)) continue;
    seen.add(entry.containerPath);
    mounts.push({
      hostPath: `${cacheBase}/${entry.hostSubdir}`,
      containerPath: entry.containerPath,
    });
  }
  return mounts;
}
