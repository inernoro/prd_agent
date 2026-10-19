export interface RuntimeBadgeInput {
  kind: 'source' | 'release' | 'mixed';
  activeProfiles: number;
  title?: string;
  label?: string;
  pendingPublish?: boolean;
  actualVersionStatus?: 'current' | 'outdated' | 'unknown';
  prebuilt?: boolean;
  prebuiltCoverage?: 'all' | 'partial' | 'none';
  actualRuntimeProfiles?: number;
  actualPrebuiltCoverage?: 'all' | 'partial' | 'none' | 'unknown';
  actualPrebuiltProfileIds?: string[];
  actualSourceProfileIds?: string[];
  unknownRuntimeProfileIds?: string[];
}
export interface RuntimeBadge {
  kind: 'release' | 'mixed' | 'pending';
  label: string;
  title: string;
  className: string;
  prebuilt?: boolean;
  lightning?: 'yellow' | 'blue';
}

export function isFullyPrebuilt(runtime: RuntimeBadgeInput | undefined): boolean {
  return runtime?.actualPrebuiltCoverage === 'all';
}

/** 分支卡文字与图标共用同一份运行事实。 */
export function branchRuntimePresentation(branch: { status: string; deployRuntime?: RuntimeBadgeInput }) {
  const badge = branchRuntimeBadge(branch);
  const iconProps = badge && (badge.lightning || badge.kind === 'pending')
    ? { partial: badge.lightning === 'blue', pending: badge.kind === 'pending', label: badge.label }
    : null;
  return { badge, iconProps };
}

export function branchRuntimeBadge(branch: { status: string; deployRuntime?: RuntimeBadgeInput }): RuntimeBadge | null {
  const runtime = branch.deployRuntime;
  if (!runtime) return null;
  const expressIntent = runtime.prebuilt || ['all', 'partial'].includes(runtime.prebuiltCoverage || '');
  const suffix = (runtime.pendingPublish ? ' · 配置待生效' : '') + (runtime.actualVersionStatus === 'outdated' ? ' · 版本待更新' : runtime.actualVersionStatus === 'unknown' ? ' · 版本待核验' : '');
  if (['stopped', 'cold', 'idle'].includes(branch.status) && (runtime.prebuilt || ['all', 'partial'].includes(runtime.prebuiltCoverage || '') || ['all', 'partial', 'unknown'].includes(runtime.actualPrebuiltCoverage || ''))) {
    return {
      kind: 'pending', label: expressIntent ? '极速配置 · 未运行' : '未运行', title: '分支未运行；历史镜像不能证明当前全部极速。',
      className: 'border-[hsl(var(--hairline))] bg-muted/30 text-muted-foreground',
    };
  }
  const total = runtime.actualRuntimeProfiles ?? runtime.activeProfiles;
  if (isFullyPrebuilt(runtime)) {
    return {
      kind: 'release', prebuilt: true, lightning: 'yellow', label: `极速版${suffix}`,
      title: runtime.title || '全部服务已实际运行预构建镜像',
      className: 'border-express-all/40 bg-express-all/10 text-express-all',
    };
  }
  if (runtime.actualPrebuiltCoverage === 'partial') {
    const fast = runtime.actualPrebuiltProfileIds?.length ?? 0;
    const source = runtime.actualSourceProfileIds ?? [];
    const unknown = runtime.unknownRuntimeProfileIds ?? [];
    return {
      kind: 'mixed', prebuilt: true, lightning: 'blue',
      label: `部分极速 ${fast}/${total}${suffix}`,
      title: `实际极速 ${fast}/${total}；非极速服务：${source.join('、') || '无'}；未运行或未核验：${unknown.join('、') || '无'}。${runtime.title || ''}`,
      className: 'border-express-partial/40 bg-express-partial/10 text-express-partial',
    };
  }
  // 旧后端/旧容器缺运行证据、停止或纯配置极速都不能亮黄闪电。
  if (runtime.prebuilt || runtime.prebuiltCoverage === 'all' || runtime.prebuiltCoverage === 'partial' || runtime.actualPrebuiltCoverage === 'unknown') {
    const stopped = ['stopped', 'cold', 'idle'].includes(branch.status);
    return {
      kind: 'pending', label: expressIntent ? (stopped ? '极速配置 · 未运行' : runtime.actualPrebuiltCoverage === 'none' ? '极速配置 · 未生效' : '极速运行待核验') : '运行待核验',
      title: `${runtime.title || ''} 缺少完整实际运行证据；不能按配置判为全部极速。`,
      className: 'border-[hsl(var(--hairline))] bg-muted/30 text-muted-foreground',
    };
  }
  if (runtime.kind === 'release') return {
    kind: 'release', label: runtime.label || '发布版', title: runtime.title || '当前使用发布版模式',
    className: 'border-ok/35 bg-ok/10 text-ok',
  };
  if (runtime.pendingPublish) return {
    kind: 'pending', label: '发布版·待生效', title: runtime.title || '等待重新部署生效',
    className: 'border-[hsl(var(--hairline))] bg-muted/30 text-muted-foreground',
  };
  if (runtime.kind === 'mixed') return {
    kind: 'mixed', label: runtime.label || '混合', title: runtime.title || '发布版与源码服务并存',
    className: 'border-violet-400/35 bg-violet-400/10 text-violet-700 dark:text-violet-300',
  };
  return null;
}
