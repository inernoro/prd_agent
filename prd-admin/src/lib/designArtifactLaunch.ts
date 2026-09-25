export type DesignArtifactTarget = 'web-page' | 'html-ppt';

export interface DesignArtifactLaunchContext {
  target: DesignArtifactTarget;
  sourceStoreId: string;
  sourceEntryId: string;
  sourceTitle: string;
  sourceStoreName?: string;
  /**
   * 发起方已经写好的那句要求（可选）。只用来预填目标工作台的输入框，不会被自动发送：
   * 用户在网页工作台里写过的话，换到 PPT 智能体后不该让他再敲一遍。
   */
  request?: string;
}

/** 与服务端「设计要求不能超过 4000 个字符」同一上限，超出部分截掉而不是整条丢弃。 */
export const MAX_LAUNCH_REQUEST_CHARS = 4000;

export function buildDesignArtifactLaunchPath(context: DesignArtifactLaunchContext): string {
  const params = new URLSearchParams({
    designTarget: context.target,
    sourceStore: context.sourceStoreId,
    sourceEntry: context.sourceEntryId,
    sourceTitle: context.sourceTitle,
  });
  if (context.sourceStoreName) params.set('sourceStoreName', context.sourceStoreName);
  const request = context.request?.trim().slice(0, MAX_LAUNCH_REQUEST_CHARS);
  if (request) params.set('request', request);
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
  const request = params.get('request')?.trim().slice(0, MAX_LAUNCH_REQUEST_CHARS);
  return {
    target,
    sourceStoreId,
    sourceEntryId,
    sourceTitle,
    sourceStoreName: params.get('sourceStoreName')?.trim() || undefined,
    ...(request ? { request } : {}),
  };
}
