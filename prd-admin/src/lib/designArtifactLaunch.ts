export type DesignArtifactTarget = 'web-page' | 'html-ppt';

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
  const pathname = context.target === 'html-ppt' ? '/md-to-ppt-agent' : '/web-pages';
  return `${pathname}?${params.toString()}`;
}

export function parseDesignArtifactLaunch(search: string): DesignArtifactLaunchContext | null {
  const params = new URLSearchParams(search);
  const target = params.get('designTarget');
  const sourceStoreId = params.get('sourceStore')?.trim();
  const sourceEntryId = params.get('sourceEntry')?.trim();
  const sourceTitle = params.get('sourceTitle')?.trim();
  if ((target !== 'web-page' && target !== 'html-ppt') || !sourceStoreId || !sourceEntryId || !sourceTitle)
    return null;
  return {
    target,
    sourceStoreId,
    sourceEntryId,
    sourceTitle,
    sourceStoreName: params.get('sourceStoreName')?.trim() || undefined,
  };
}
