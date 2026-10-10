import { parseInlinePrompt } from '@/lib/visualAgentPromptUtils';

export type VisualAgentHandoffImage = {
  src: string;
  name?: string;
};

export type VisualAgentHandoffPayload = {
  messageText: string;
  assetId: string | null;
  imageSize: { w: number; h: number } | null;
  modelId: string;
  inlineImage: VisualAgentHandoffImage | null;
  timestamp: number;
};

type CreateVisualAgentHandoffInput = {
  prompt: string;
  size: string;
  assetId?: string | null;
  imageSize?: { w: number; h: number } | null;
  modelId?: string | null;
  inlineImage?: VisualAgentHandoffImage | null;
  timestamp?: number;
};

/**
 * 首页到画板的交接包。
 *
 * 参考图必须是独立字段，不能再塞进 messageText：消息标记函数会刻意拒绝 data:/blob:
 * URL，避免把整张图片写进聊天文本。此前首页误用了那个函数，导致缩略图仍在、交接包却
 * 只剩文字，后端最终按文生图执行。
 */
export function createVisualAgentHandoffPayload(input: CreateVisualAgentHandoffInput): VisualAgentHandoffPayload {
  const prompt = String(input.prompt ?? '').trim();
  const size = String(input.size ?? '').trim();
  const sizeToken = size ? `(@size:${size}) ` : '';
  const inlineSrc = String(input.inlineImage?.src ?? '').trim();
  const inlineName = String(input.inlineImage?.name ?? '').trim();

  return {
    messageText: `${sizeToken}${prompt}`,
    assetId: String(input.assetId ?? '').trim() || null,
    imageSize: input.imageSize ?? null,
    modelId: String(input.modelId ?? '').trim(),
    inlineImage: inlineSrc ? { src: inlineSrc, ...(inlineName ? { name: inlineName } : {}) } : null,
    timestamp: input.timestamp ?? Date.now(),
  };
}

export type ParsedVisualAgentHandoff = {
  prompt: ReturnType<typeof parseInlinePrompt>;
  assetId: string | null;
  imageSize: { w: number; h: number } | null;
  modelId: string;
};

/** 同时兼容旧交接包里的 [IMAGE ...] 远程 URL 标记。 */
export function parseVisualAgentHandoff(raw: string): ParsedVisualAgentHandoff | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const data = JSON.parse(text) as Partial<VisualAgentHandoffPayload>;
  const parsed = parseInlinePrompt(String(data.messageText ?? ''));
  const explicitSrc = String(data.inlineImage?.src ?? '').trim();
  const explicitName = String(data.inlineImage?.name ?? '').trim();
  const imageSize = data.imageSize;

  return {
    prompt: {
      ...parsed,
      inlineImage: explicitSrc
        ? { src: explicitSrc, ...(explicitName ? { name: explicitName } : {}) }
        : parsed.inlineImage,
    },
    assetId: String(data.assetId ?? '').trim() || null,
    imageSize: imageSize && Number(imageSize.w) > 0 && Number(imageSize.h) > 0
      ? { w: Number(imageSize.w), h: Number(imageSize.h) }
      : null,
    modelId: String(data.modelId ?? '').trim(),
  };
}
