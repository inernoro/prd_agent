import type { SseEvent } from '@/lib/sse';
import type { DesignArtifactRunSummary } from '@/services/real/webPages';

export type SiteGenerationProgressEvent =
  | { kind: 'phase'; message?: string; progress?: number }
  | { kind: 'thinking'; text: string }
  | { kind: 'delta'; text: string }
  | { kind: 'done'; siteId: string; siteUrl?: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'unknown' };

export function resolveGeneratedSiteId(run: DesignArtifactRunSummary): string | null {
  return run.artifactSiteId || run.producedArtifactSiteId || null;
}

export function parseSiteGenerationProgressEvent(event: SseEvent): SiteGenerationProgressEvent {
  if (!event.data) return { kind: 'unknown' };
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(event.data) as Record<string, unknown>;
  } catch {
    return { kind: 'unknown' };
  }

  if (event.event === 'phase') {
    return {
      kind: 'phase',
      message: typeof data.message === 'string' ? data.message : undefined,
      progress: typeof data.progress === 'number' ? data.progress : undefined,
    };
  }
  if (event.event === 'thinking' && typeof data.text === 'string')
    return { kind: 'thinking', text: data.text };
  if (event.event === 'delta' && typeof data.text === 'string')
    return { kind: 'delta', text: data.text };
  if (event.event === 'done' && typeof data.siteId === 'string') {
    return {
      kind: 'done',
      siteId: data.siteId,
      siteUrl: typeof data.siteUrl === 'string' ? data.siteUrl : undefined,
    };
  }
  if (event.event === 'cancelled') {
    return {
      kind: 'cancelled',
      message: typeof data.message === 'string' ? data.message : '网页生成已取消',
    };
  }
  if (event.event === 'error') {
    return {
      kind: 'error',
      message: typeof data.message === 'string' ? data.message : '网页生成失败',
    };
  }
  return { kind: 'unknown' };
}
