interface DependencyProfile {
  id: string;
  dependsOn?: string[];
}

/**
 * 将 Compose 中的项目内服务依赖对齐到 CDS 持久化后的 profile id。
 *
 * 非默认项目会把 profile id 从 `api` 改成 `api-<project-slug>`，但
 * Compose 的 depends_on 仍然是 `api`。只有当作用域化目标确实存在时
 * 才重写，MongoDB、Redis 等基础设施依赖因此保持原名。
 *
 * 此函数同时用于 Quickstart 写入和部署时兼容。后者保证升级前已经
 * 存在的 profile 也能立即获得正确启动顺序，无需删除后重建。
 */
export function normalizeProjectProfileDependencies<T extends DependencyProfile>(
  profiles: T[],
  idSuffix: string,
): T[] {
  if (!idSuffix) return profiles;

  const profileIds = new Set(profiles.map((profile) => profile.id));

  let anyChanged = false;
  const normalized = profiles.map((profile) => {
    if (!profile.dependsOn || profile.dependsOn.length === 0) return profile;

    let changed = false;
    const dependsOn = profile.dependsOn.map((dependencyId) => {
      if (profileIds.has(dependencyId)) return dependencyId;

      const scopedDependencyId = `${dependencyId}${idSuffix}`;
      if (!profileIds.has(scopedDependencyId)) return dependencyId;

      changed = true;
      return scopedDependencyId;
    });

    if (!changed) return profile;
    anyChanged = true;
    return { ...profile, dependsOn };
  });

  return anyChanged ? normalized : profiles;
}
