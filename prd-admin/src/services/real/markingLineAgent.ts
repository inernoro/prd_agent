/**
 * 赋码产线 Agent API（SSE 流式 + 示意图位图）
 */

import { apiRequest } from './apiClient';

/** POST SSE：根据简述生成产线示意图说明 */
export function getMarkingLineDiagramStreamUrl(): string {
  return '/api/marking-line-agent/diagram/stream';
}

export type MarkingLineDiagramImageDto = {
  imageUrl?: string | null;
  imageBase64?: string | null;
  mimeType?: string | null;
  imagePromptUsed?: string | null;
  revisedPrompt?: string | null;
  promptComposerModel?: string | null;
  promptComposerPlatform?: string | null;
};

/** POST：根据简述生成产线示意图位图（PNG 等，由上游决定） */
export function postMarkingLineDiagramImage(
  brief: string,
  opts?: { responseFormat?: 'url' | 'b64_json'; signal?: AbortSignal }
) {
  return apiRequest<MarkingLineDiagramImageDto>('/api/marking-line-agent/diagram/image', {
    method: 'POST',
    body: {
      brief: brief.trim(),
      responseFormat: opts?.responseFormat ?? 'url',
    },
    signal: opts?.signal,
  });
}
