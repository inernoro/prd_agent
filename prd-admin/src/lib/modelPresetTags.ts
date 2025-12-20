export type PresetTagKey =
  | 'reasoning'
  | 'vision'
  | 'websearch'
  | 'function_calling'
  | 'embedding'
  | 'rerank'
  | 'image_generation'
  | 'free';

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

/**
 * 预设标签（轻量启发式）：用于“可用模型列表”里给用户快速判断模型类型。
 * - 不做持久化；每次刷新/打开都会重新推断
 * - 只依赖 modelName/displayName（避免引入后端协议变更）
 */
export function inferPresetTagKeys(modelName: string, displayName?: string): PresetTagKey[] {
  const s = `${displayName ?? ''} ${modelName ?? ''}`.toLowerCase();
  const out: PresetTagKey[] = [];

  if (/(free|gratis|免费)/.test(s)) out.push('free');

  // image-generation / t2i
  if (/(image-gen|image_generation|t2i|txt2img|text-to-image|dall-e|dalle|stable-diffusion|sdxl|kolors|flux|imagen|seedream)/.test(s)) {
    out.push('image_generation');
  }

  // embedding / rerank（优先打上，便于用户避免误选）
  if (/(embed|embedding|text-embedding|bge|e5|gte-embedding)/.test(s)) out.push('embedding');
  if (/(rerank|re-rank|ranker|reranker)/.test(s)) out.push('rerank');

  // vision
  if (/(vision|vl|multimodal|image|ocr)/.test(s)) out.push('vision');

  // websearch
  if (/(search|web|online|联网|browse|browsing)/.test(s)) out.push('websearch');

  // function calling / tools
  if (/(tool|tools|function|fn|functioncall|function_call)/.test(s)) out.push('function_calling');

  // reasoning / thinking
  if (/(reasoning|think|thinking|deepseek-r1|\\br1\\b|\\bo1\\b|\\bo3\\b|\\bo4\\b|qwq|qvq)/.test(s)) out.push('reasoning');

  return uniq(out);
}


