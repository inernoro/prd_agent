import type { BuildProfile, InfraService } from '../types.js';

/**
 * 为当前构建配置选择唯一的 SQL 初始化目标。
 *
 * 多数据库项目禁止按名称或 id 猜测：dependsOn 明确命中时必须唯一；没有声明时仅允许
 * 项目中恰好一个运行中的 SQL 服务，避免把初始化脚本写入无关数据库。
 */
export function selectSqlInitInfra(
  sqlInfra: readonly InfraService[],
  profile: Pick<BuildProfile, 'id' | 'name' | 'dependsOn'>,
): InfraService {
  const profileLabel = profile.name || profile.id;
  if (sqlInfra.length === 0) {
    throw new Error('检测到 SQL 初始化脚本，但项目没有 PostgreSQL/MySQL/MariaDB 服务可执行。');
  }

  const dependencies = new Set(profile.dependsOn ?? []);
  const declared = sqlInfra.filter((service) => (
    dependencies.has(service.id) || dependencies.has(service.name)
  ));

  if (declared.length > 1) {
    throw new Error(
      `构建配置“${profileLabel}”同时依赖多个 SQL 服务（${declared.map((service) => service.id).join('、')}），无法确定初始化目标。`,
    );
  }

  if (declared.length === 1) {
    const selected = declared[0];
    if (selected.status !== 'running') {
      throw new Error(`构建配置“${profileLabel}”声明的 SQL 服务“${selected.id}”未运行，无法执行初始化。`);
    }
    return selected;
  }

  const running = sqlInfra.filter((service) => service.status === 'running');
  if (running.length === 0) {
    throw new Error('检测到 SQL 初始化脚本，但没有已运行的 PostgreSQL/MySQL/MariaDB 服务可执行。');
  }
  if (running.length === 1) return running[0];

  throw new Error(
    `项目存在多个运行中的 SQL 服务（${running.map((service) => service.id).join('、')}），` +
    `构建配置“${profileLabel}”未通过 dependsOn 唯一声明初始化目标。`,
  );
}
