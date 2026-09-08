interface DependencyProfile {
  id: string;
  dependsOn?: string[];
  /** cds.calls 显式声明的被调方，与 depends_on 一样写的是 compose 服务名 */
  calls?: string[];
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
 *
 * cds.calls 与 depends_on 同一规则：写的是 compose 服务名，导入后 id 加了项目后缀，
 * 被调方也要跟着加，否则服务图丢边、服务被判游离。所有导入路径（导入审批、克隆导入、
 * Quickstart）都经这里，不各自再写一份（Codex 五轮 P2）。
 */
export function normalizeProjectProfileDependencies<T extends DependencyProfile>(
  profiles: T[],
  idSuffix: string,
): T[] {
  if (!idSuffix) return profiles;

  const profileIds = new Set(profiles.map((profile) => profile.id));

  const scopeList = (ids: string[] | undefined): { ids?: string[]; changed: boolean } => {
    if (!ids || ids.length === 0) return { ids, changed: false };
    let changed = false;
    const out = ids.map((dependencyId) => {
      if (profileIds.has(dependencyId)) return dependencyId;

      const scopedDependencyId = `${dependencyId}${idSuffix}`;
      if (!profileIds.has(scopedDependencyId)) return dependencyId;

      changed = true;
      return scopedDependencyId;
    });
    return { ids: out, changed };
  };

  let anyChanged = false;
  const normalized = profiles.map((profile) => {
    const dependsOn = scopeList(profile.dependsOn);
    const calls = scopeList(profile.calls);
    if (!dependsOn.changed && !calls.changed) return profile;
    anyChanged = true;
    return {
      ...profile,
      ...(dependsOn.changed ? { dependsOn: dependsOn.ids } : {}),
      ...(calls.changed ? { calls: calls.ids } : {}),
    };
  });

  return anyChanged ? normalized : profiles;
}
