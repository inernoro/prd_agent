import type { SseEvent } from '@/lib/sse';
import type { DesignArtifactRunSummary } from '@/services/real/webPages';

export type SiteGenerationProgressEvent =
  | { kind: 'phase'; message?: string; progress?: number }
  | { kind: 'model'; model: string; platform: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'delta'; text: string }
  | { kind: 'done'; siteId: string; siteUrl?: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'unknown' };

export function resolveGeneratedSiteId(run: DesignArtifactRunSummary): string | null {
  return run.artifactSiteId || run.producedArtifactSiteId || null;
}

/** 后端只给了模型名、没给平台名时的兜底称谓。三个消费点共用这一份，别各写各的。 */
export const GATEWAY_PLATFORM_FALLBACK = 'LLM Gateway';

/**
 * 刷新后从 run 读回徽章。流事件只在开头出现一次，错过就只能靠这条恢复，
 * 所以恢复路径必须和流事件用同一套兜底口径。
 */
export function resolveRunModelBadge(
  run: DesignArtifactRunSummary,
): { model: string; platform: string } | null {
  const model = run.resolvedModel?.trim();
  if (!model) return null;
  return { model, platform: run.resolvedPlatform?.trim() || GATEWAY_PLATFORM_FALLBACK };
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
  // 实际执行的模型只在流的开头出现一次；面板顶部按「{模型} · {平台}」展示，
  // 值一律来自后端，前端不推断（.claude/rules/ai-model-visibility.md §2）。
  if (event.event === 'model' && typeof data.model === 'string' && data.model.trim()) {
    return {
      kind: 'model',
      model: data.model,
      platform: typeof data.platform === 'string' && data.platform.trim() ? data.platform : GATEWAY_PLATFORM_FALLBACK,
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
