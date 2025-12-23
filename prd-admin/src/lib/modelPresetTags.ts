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
 * - 只依赖 modelName/displayName/providerId（避免引入后端协议变更）
 *
 * 设计目标：
 * - 尽量贴近 Cherry Studio 的默认体验（regex 判定 + provider 特例）
 * - 不引入 capabilities（我们当前 available-models 接口没有该字段）
 */
export function inferPresetTagKeys(modelName: string, displayName?: string, providerId?: string): PresetTagKey[] {
  const provider = (providerId ?? '').trim().toLowerCase();
  const s = `${displayName ?? ''} ${modelName ?? ''}`.toLowerCase();
  const out: PresetTagKey[] = [];

  // Cherry：provider=cherryai 视为免费；否则 fallback 到关键字
  if (provider === 'cherryai' || /(free|gratis|免费)/.test(s)) out.push('free');

  // image-generation / t2i
  if (/(image-gen|image_generation|t2i|txt2img|text-to-image|dall-e|dalle|stable-diffusion|sdxl|kolors|flux|imagen|seedream)/.test(s)) {
    out.push('image_generation');
  }

  // embedding / rerank（优先打上，便于用户避免误选）
  if (/(embed|embedding|text-embedding|bge|e5|gte-embedding)/.test(s)) out.push('embedding');
  if (/(rerank|re-rank|ranker|reranker)/.test(s)) out.push('rerank');

  // vision（Cherry：vision 会先排除 embedding/rerank；我们同样避免误判）
  // 注意：不要用过泛的 `image` 直接兜底，否则会把大量非视觉模型误标（我们仅保留更“像视觉”的关键词）
  const maybeVision =
    /(vision|[\s\-_]vl[\s\-_]|multimodal|multi-modal|mm[-\s]?vision|image-understanding|image_understanding|ocr|caption)/.test(s) ||
    /(gpt-4o|gpt-4\.1|gemini.*(vision|pro-vision)|claude.*(vision|vl)|qwen.*vl)/.test(s);
  if (!out.includes('embedding') && !out.includes('rerank') && maybeVision) out.push('vision');

  // websearch
  if (/(search|web|online|联网|browse|browsing)/.test(s)) out.push('websearch');

  // function calling / tools
  if (/(tooluse|tool-use|tool|tools|function|fn|functioncall|function_call|function-calling)/.test(s)) out.push('function_calling');

  // reasoning / thinking
  if (/(reasoning|think|thinking|deepseek-r1|\\br1\\b|\\bo1\\b|\\bo3\\b|\\bo4\\b|qwq|qvq)/.test(s)) out.push('reasoning');

  // 合理默认：非 embedding/rerank/t2i 的模型，绝大多数都是对话/推理模型
  if (!out.includes('embedding') && !out.includes('rerank') && !out.includes('image_generation')) out.push('reasoning');

  return uniq(out);
}

export type AvailableModelsTabKey = 'all' | 'reasoning' | 'vision' | 'web' | 'free' | 'embedding' | 'rerank' | 'tools';

/**
 * 用于“可用模型弹窗”的 Tab 过滤（允许一个模型同时出现在多个 Tab）。
 * - reasoning：默认兜底（除 embedding/rerank/t2i）
 * - web/tools 等：基于 tags 命中
 */
export function matchAvailableModelsTab(args: {
  tab: AvailableModelsTabKey;
  modelName: string;
  displayName?: string;
  providerId?: string;
}): boolean {
  const { tab, modelName, displayName, providerId } = args;
  if (tab === 'all') return true;
  const tags = inferPresetTagKeys(modelName, displayName, providerId);
  if (tab === 'embedding') return tags.includes('embedding');
  if (tab === 'rerank') return tags.includes('rerank');
  if (tab === 'vision') return tags.includes('vision');
  if (tab === 'web') return tags.includes('websearch');
  if (tab === 'free') return tags.includes('free');
  if (tab === 'tools') return tags.includes('function_calling');
  // reasoning：兜底型 tab
  return !tags.includes('embedding') && !tags.includes('rerank') && !tags.includes('image_generation');
}



