/**
 * VLM 截图识别结果 → 缺陷描述的非破坏性自动填充。
 *
 * 原则（预期管理 / AI 最小惊讶）：
 * - 永远只「追加」，绝不覆盖或改写用户已输入的内容；
 * - 追加块带【AI 截图识别】标签，用户一眼可辨、可编辑可删除；
 * - 同一段识别结果只追加一次（防重复分析 / 重复回调）。
 */

const AI_BLOCK_LABEL = '【AI 截图识别】';

/** 取识别结果的第一句话做标题候选（首行即标题的约定），过长则截断 */
export function firstSentenceOf(text: string, maxLength = 60): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const match = trimmed.match(/^[^。！？.!?\n]+[。！？.!?]?/);
  const sentence = (match ? match[0] : trimmed).trim();
  return sentence.length > maxLength ? `${sentence.slice(0, maxLength)}...` : sentence;
}

/**
 * 把一条 VLM 识别描述合并进当前缺陷描述。
 * - 内容为空：第一行放识别结果的第一句（作标题），空一行后接带标签的完整描述
 * - 已有内容：在末尾追加带标签的描述块，用户已输入的部分逐字保留
 * - 描述已存在于内容中（用户未删或重复回调）：原样返回，不重复追加
 */
export function mergeAiScreenshotDescription(current: string, description: string): string {
  const desc = description.trim();
  if (!desc) return current;
  if (current.includes(desc)) return current;

  const block = `${AI_BLOCK_LABEL}${desc}`;
  if (!current.trim()) {
    const title = firstSentenceOf(desc);
    return title ? `${title}\n\n${block}` : block;
  }
  return `${current.replace(/\s+$/, '')}\n\n${block}`;
}
