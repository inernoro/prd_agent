/** 全部生成目标。新增一种就在这里加，入口组件与路由守卫都从这份清单派生。 */
export const DESIGN_ARTIFACT_TARGETS = ['web-page', 'html-ppt'] as const;
export type DesignArtifactTarget = (typeof DESIGN_ARTIFACT_TARGETS)[number];

/** 每个目标落到哪条路由：唯一定义处，守卫测试据此核对路由真的注册过。 */
export function designArtifactLaunchPathname(target: DesignArtifactTarget): string {
  return target === 'html-ppt' ? '/md-to-ppt-agent' : '/web-pages';
}

export interface DesignArtifactLaunchContext {
  target: DesignArtifactTarget;
  sourceStoreId: string;
  sourceEntryId: string;
  sourceTitle: string;
  sourceStoreName?: string;
}

export function buildDesignArtifactLaunchPath(context: DesignArtifactLaunchContext): string {
  const params = new URLSearchParams({
    designTarget: context.target,
    sourceStore: context.sourceStoreId,
    sourceEntry: context.sourceEntryId,
    sourceTitle: context.sourceTitle,
  });
  if (context.sourceStoreName) params.set('sourceStoreName', context.sourceStoreName);
  return `${designArtifactLaunchPathname(context.target)}?${params.toString()}`;
}

export function parseDesignArtifactLaunch(search: string): DesignArtifactLaunchContext | null {
  const params = new URLSearchParams(search);
  const target = params.get('designTarget');
  const sourceStoreId = params.get('sourceStore')?.trim();
  const sourceEntryId = params.get('sourceEntry')?.trim();
  const sourceTitle = params.get('sourceTitle')?.trim();
  if (!isDesignArtifactTarget(target) || !sourceStoreId || !sourceEntryId || !sourceTitle)
    return null;
  return {
    target,
    sourceStoreId,
    sourceEntryId,
    sourceTitle,
    sourceStoreName: params.get('sourceStoreName')?.trim() || undefined,
  };
}

function isDesignArtifactTarget(value: string | null): value is DesignArtifactTarget {
  return (DESIGN_ARTIFACT_TARGETS as readonly string[]).includes(value ?? '');
}
