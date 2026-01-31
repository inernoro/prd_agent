/**
 * 图片引用解析器
 *
 * 统一处理三个输入链路的图片引用：
 * 1. RichComposer chip 引用
 * 2. 文本中的 @imgN 引用
 * 3. 左侧画布选择
 * 4. 首页带入的内联图片
 *
 * @see doc/design.inline-image-chat.md
 */

import type {
  ImageRefResolveInput,
  ImageRefResolveResult,
  ResolvedImageRef,
} from './imageRefContract';

/**
 * 旧格式内联图片的正则（兼容首页带入）
 * 支持两种格式:
 * - [IMAGE=url|name]
 * - [IMAGE src="url" name="name"]
 */
const OLD_FORMAT_REGEX = /\[IMAGE(?:=([^|\]]+)\|([^\]]*)|[^\]]*src="([^"]+)"[^\]]*name="([^"]*)"[^\]]*)\]/g;

/**
 * @imgN 引用的正则
 */
const IMG_REF_REGEX = /@img(\d+)/g;

/**
 * 解析图片引用（统一入口）
 *
 * 优先级：chipRefs > 文本中的 @imgN > selectedKeys > inlineImage
 */
export function resolveImageRefs(input: ImageRefResolveInput): ImageRefResolveResult {
  const { rawText, chipRefs = [], selectedKeys = [], inlineImage, canvas } = input;

  const refs: ResolvedImageRef[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const seenKeys = new Set<string>();

  // 用于追踪已处理的 refId（避免 chipRefs 和 text 重复）
  const processedRefIds = new Set<number>();

  // 1. 优先处理 chipRefs（来自 RichComposer）
  for (const chip of chipRefs) {
    const item = canvas.find((c) => c.key === chip.canvasKey);
    if (!item) {
      warnings.push(`chip 引用的图片不存在: @img${chip.refId} (key=${chip.canvasKey})`);
      continue;
    }
    if (seenKeys.has(item.key)) continue;
    seenKeys.add(item.key);
    processedRefIds.add(chip.refId);
    refs.push({
      canvasKey: item.key,
      refId: item.refId,
      src: item.src,
      label: item.label,
      source: 'chip',
    });
  }

  // 2. 解析文本中的 @imgN（仅补充 chipRefs 中没有的）
  const textRefIds = extractRefIdsFromText(rawText);
  for (const refId of textRefIds) {
    if (processedRefIds.has(refId)) continue; // chip 已经有了
    const item = canvas.find((c) => c.refId === refId);
    if (!item) {
      warnings.push(`文本中引用的图片不存在: @img${refId}`);
      continue;
    }
    if (seenKeys.has(item.key)) continue;
    seenKeys.add(item.key);
    processedRefIds.add(refId);
    refs.push({
      canvasKey: item.key,
      refId: item.refId,
      src: item.src,
      label: item.label,
      source: 'text',
    });
  }

  // 3. 如果没有任何引用，使用 selectedKeys 作为默认
  if (refs.length === 0 && selectedKeys.length > 0) {
    for (const key of selectedKeys) {
      const item = canvas.find((c) => c.key === key);
      if (!item) continue;
      if (seenKeys.has(item.key)) continue;
      seenKeys.add(item.key);
      refs.push({
        canvasKey: item.key,
        refId: item.refId,
        src: item.src,
        label: item.label,
        source: 'selected',
      });
    }
  }

  // 4. 处理旧格式内联图片（仅当没有其他引用时）
  let cleanText = rawText;
  if (inlineImage?.src) {
    // 清理旧格式标记
    cleanText = rawText.replace(OLD_FORMAT_REGEX, '').trim();

    // 尝试在 canvas 中找到匹配的图片
    const inlineItem = canvas.find((c) => c.src === inlineImage.src);
    if (inlineItem && !seenKeys.has(inlineItem.key)) {
      refs.push({
        canvasKey: inlineItem.key,
        refId: inlineItem.refId,
        src: inlineItem.src,
        label: inlineImage.name || inlineItem.label,
        source: 'inline',
      });
    } else if (!inlineItem && refs.length === 0) {
      // 图片不在 canvas 中，但也没有其他引用 - 这可能是从首页直接带入的
      warnings.push(`内联图片不在当前画布中: ${inlineImage.name || '未命名'}`);
    }
  }

  // 验证：检查是否有内容
  const trimmedText = cleanText.trim();
  if (!trimmedText && refs.length === 0) {
    errors.push('消息内容为空');
  }

  return {
    ok: errors.length === 0,
    cleanText: cleanText,
    refs,
    warnings,
    errors,
  };
}

/**
 * 从文本中提取 @imgN 引用的 ID（按出现顺序，去重）
 */
export function extractRefIdsFromText(text: string): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();

  let match: RegExpExecArray | null;
  const regex = new RegExp(IMG_REF_REGEX.source, 'g'); // 重新创建避免 lastIndex 问题

  while ((match = regex.exec(text)) !== null) {
    const id = parseInt(match[1], 10);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

/**
 * 构建发送给后端的请求文本（包含引用说明）
 *
 * 这个函数用于替代原有的 buildRequestTextWithRefs
 */
export function buildRequestText(
  cleanText: string,
  refs: ResolvedImageRef[]
): { requestText: string; primaryRef: ResolvedImageRef | null } {
  if (refs.length === 0) {
    return { requestText: cleanText, primaryRef: null };
  }

  const lines = refs.map((ref) => {
    return `- @img${ref.refId}: ${ref.label || '（无描述）'}`;
  });

  const requestText = `${cleanText}\n\n【引用图片（按顺序）】\n${lines.join('\n')}`;

  return {
    requestText,
    primaryRef: refs[0] ?? null,
  };
}

/**
 * 清理旧格式标记
 */
export function cleanOldFormatMarkers(text: string): string {
  return text.replace(OLD_FORMAT_REGEX, '').trim();
}

