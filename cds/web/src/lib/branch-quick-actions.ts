interface BranchQuickActionInput {
  status: string;
  services?: Record<string, { status: string }>;
}

const ACTIVE_SERVICE_STATES = new Set(['running', 'building', 'starting', 'restarting']);

/** 只有真正停过且当前没有活动容器的分支，才在卡片上暴露一键启动。 */
export function canQuickStartBranch(branch: BranchQuickActionInput): boolean {
  if (['running', 'building', 'starting', 'restarting', 'stopping', 'error'].includes(branch.status)) {
    return false;
  }
  const services = Object.values(branch.services || {});
  return services.length > 0
    && services.some((service) => service.status === 'stopped')
    && !services.some((service) => ACTIVE_SERVICE_STATES.has(service.status));
}
