/**
 * Cherry Studio 分类逻辑（尽量 1:1 迁移默认判定）
 *
 * 目标：
 * - 让 prd-admin 的“可用模型列表”在 视觉/推理/联网/免费/嵌入/重排/工具 等 Tab 上，与 Cherry Studio 默认一致
 * - 仅使用当前我们 available-models 接口可得到的信息：providerId/platformType + modelName/displayName
 *
 * 注意：
 * - Cherry 支持 capabilities 手动覆盖（isUserSelectedModelType），我们在这里预留 override，但默认不启用（由上层传入）。
 */

export type CherryModelType =
  | 'vision'
  | 'embedding'
  | 'rerank'
  | 'function_calling'
  | 'web_search'
  | 'reasoning';

export type CherryCapabilityOverride = Partial<Record<CherryModelType, boolean>>;

export type CherryModelInput = {
  id: string;
  name: string;
  providerId: string;
  platformType?: string;
  overrides?: CherryCapabilityOverride;
};

function normProviderId(providerId: string | undefined): string {
  return (providerId ?? '').trim().toLowerCase();
}

function getLowerBaseModelName(modelId: string, slashDelimiter: string = '/'): string {
  let s = (modelId ?? '').trim().toLowerCase();
  if (slashDelimiter) {
    const slash = s.lastIndexOf(slashDelimiter);
    if (slash >= 0 && slash < s.length - 1) s = s.slice(slash + 1);
  }
  const colon = s.lastIndexOf(':');
  if (colon >= 0 && colon < s.length - 1) s = s.slice(colon + 1);
  return s;
}

function pickOverride(model: CherryModelInput, type: CherryModelType): boolean | undefined {
  const o = model.overrides;
  return o ? o[type] : undefined;
}

// -----------------------------
// embedding / rerank (from Cherry)
// -----------------------------

const EMBEDDING_REGEX =
  /(?:^text-|embed|bge-|e5-|LLM2Vec|retrieval|uae-|gte-|jina-clip|jina-embeddings|voyage-)/i;

const RERANKING_REGEX = /(?:rerank|re-rank|re-ranker|re-ranking|retrieval|retriever)/i;

export function isRerankModel(model: CherryModelInput): boolean {
  const ov = pickOverride(model, 'rerank');
  if (ov !== undefined) return ov;
  const modelId = getLowerBaseModelName(model.id);
  return RERANKING_REGEX.test(modelId) || false;
}

export function isEmbeddingModel(model: CherryModelInput): boolean {
  if (!model || isRerankModel(model)) return false;
  const ov = pickOverride(model, 'embedding');
  if (ov !== undefined) return ov;

  const pid = normProviderId(model.providerId);
  const modelId = getLowerBaseModelName(model.id);

  // Cherry: anthropic 永远 false
  if (['anthropic'].includes(pid)) return false;

  // Cherry: doubao 特例用 name
  if (pid === 'doubao' || modelId.includes('doubao')) {
    return EMBEDDING_REGEX.test(model.name);
  }
  return EMBEDDING_REGEX.test(modelId) || false;
}

// -----------------------------
// vision / t2i (from Cherry)
// -----------------------------

const visionAllowedModels = [
  'llava',
  'moondream',
  'minicpm',
  'gemini-1\\.5',
  'gemini-2\\.0',
  'gemini-2\\.5',
  'gemini-3-(?:flash|pro)(?:-preview)?',
  'gemini-(flash|pro|flash-lite)-latest',
  'gemini-exp',
  'claude-3',
  'claude-haiku-4',
  'claude-sonnet-4',
  'claude-opus-4',
  'vision',
  'glm-4(?:\\.\\d+)?v(?:-[\\w-]+)?',
  'qwen-vl',
  'qwen2-vl',
  'qwen2.5-vl',
  'qwen3-vl',
  'qwen2.5-omni',
  'qwen3-omni(?:-[\\w-]+)?',
  'qvq',
  'internvl2',
  'grok-vision-beta',
  'grok-4(?:-[\\w-]+)?',
  'pixtral',
  'gpt-4(?:-[\\w-]+)',
  'gpt-4.1(?:-[\\w-]+)?',
  'gpt-4o(?:-[\\w-]+)?',
  'gpt-4.5(?:-[\\w-]+)',
  'gpt-5(?:-[\\w-]+)?',
  'chatgpt-4o(?:-[\\w-]+)?',
  'o1(?:-[\\w-]+)?',
  'o3(?:-[\\w-]+)?',
  'o4(?:-[\\w-]+)?',
  'deepseek-vl(?:[\\w-]+)?',
  'kimi-latest',
  'gemma-3(?:-[\\w-]+)',
  'doubao-seed-1[.-][68](?:-[\\w-]+)?',
  'doubao-seed-code(?:-[\\w-]+)?',
  'kimi-thinking-preview',
  'gemma3(?:[-:\\w]+)?',
  'kimi-vl-a3b-thinking(?:-[\\w-]+)?',
  'llama-guard-4(?:-[\\w-]+)?',
  'llama-4(?:-[\\w-]+)?',
  'step-1o(?:.*vision)?',
  'step-1v(?:-[\\w-]+)?',
  'qwen-omni(?:-[\\w-]+)?',
  'mistral-large-(2512|latest)',
  'mistral-medium-(2508|latest)',
  'mistral-small-(2506|latest)',
] as const;

const visionExcludedModels = [
  'gpt-4-\\d+-preview',
  'gpt-4-turbo-preview',
  'gpt-4-32k',
  'gpt-4-\\d+',
  'o1-mini',
  'o3-mini',
  'o1-preview',
  'AIDC-AI/Marco-o1',
] as const;

const VISION_REGEX = new RegExp(`\\b(?!(?:${visionExcludedModels.join('|')})\\b)(${visionAllowedModels.join('|')})\\b`, 'i');

const IMAGE_ENHANCEMENT_MODELS = [
  'grok-2-image(?:-[\\w-]+)?',
  'qwen-image-edit',
  'gpt-image-1',
  'gemini-2.5-flash-image(?:-[\\w-]+)?',
  'gemini-2.0-flash-preview-image-generation',
  'gemini-3(?:\\.\\d+)?-pro-image(?:-[\\w-]+)?',
] as const;

const IMAGE_ENHANCEMENT_MODELS_REGEX = new RegExp(IMAGE_ENHANCEMENT_MODELS.join('|'), 'i');

const TEXT_TO_IMAGE_REGEX = /flux|diffusion|stabilityai|sd-|dall|cogview|janus|midjourney|mj-|imagen|gpt-image/i;

export function isTextToImageModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id);
  return TEXT_TO_IMAGE_REGEX.test(modelId);
}

export function isVisionModel(model: CherryModelInput): boolean {
  if (!model || isEmbeddingModel(model) || isRerankModel(model)) return false;
  const ov = pickOverride(model, 'vision');
  if (ov !== undefined) return ov;

  const pid = normProviderId(model.providerId);
  const modelId = getLowerBaseModelName(model.id);

  if (pid === 'doubao' || modelId.includes('doubao')) {
    return VISION_REGEX.test(model.name) || VISION_REGEX.test(modelId) || false;
  }
  return VISION_REGEX.test(modelId) || IMAGE_ENHANCEMENT_MODELS_REGEX.test(modelId) || false;
}

// -----------------------------
// function calling (from Cherry)
// -----------------------------

const FUNCTION_CALLING_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4',
  'gpt-4.5',
  'gpt-oss(?:-[\\w-]+)',
  'gpt-5(?:-[0-9-]+)?',
  'o(1|3|4)(?:-[\\w-]+)?',
  'claude',
  'qwen',
  'qwen3',
  'hunyuan',
  'deepseek',
  'glm-4(?:-[\\w-]+)?',
  'glm-4.5(?:-[\\w-]+)?',
  'learnlm(?:-[\\w-]+)?',
  'gemini(?:-[\\w-]+)?',
  'grok-3(?:-[\\w-]+)?',
  'doubao-seed-1[.-][68](?:-[\\w-]+)?',
  'doubao-seed-code(?:-[\\w-]+)?',
  'kimi-k2(?:-[\\w-]+)?',
  'ling-\\w+(?:-[\\w-]+)?',
  'ring-\\w+(?:-[\\w-]+)?',
  'minimax-m2',
  'mimo-v2-flash',
] as const;

const FUNCTION_CALLING_EXCLUDED_MODELS = [
  'aqa(?:-[\\w-]+)?',
  'imagen(?:-[\\w-]+)?',
  'o1-mini',
  'o1-preview',
  'AIDC-AI/Marco-o1',
  'gemini-1(?:\\.[\\w-]+)?',
  'qwen-mt(?:-[\\w-]+)?',
  'gpt-5-chat(?:-[\\w-]+)?',
  'glm-4\\.5v',
  'gemini-2.5-flash-image(?:-[\\w-]+)?',
  'gemini-2.0-flash-preview-image-generation',
  'gemini-3(?:\\.\\d+)?-pro-image(?:-[\\w-]+)?',
  'deepseek-v3.2-speciale',
] as const;

const FUNCTION_CALLING_REGEX = new RegExp(
  `\\b(?!(?:${FUNCTION_CALLING_EXCLUDED_MODELS.join('|')})\\b)(?:${FUNCTION_CALLING_MODELS.join('|')})\\b`,
  'i'
);

// minimal: only what classification needs
export function isDeepSeekHybridInferenceModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id);
  const idResult =
    /(\w+-)?deepseek-v3(?:\.\d|-\d)(?:(\.|-)(?!speciale$)\w+)?$/.test(modelId) ||
    modelId.includes('deepseek-chat-v3.1') ||
    modelId.includes('deepseek-chat');
  if (idResult) return true;
  const nameAsId = { ...model, id: model.name };
  const nameModelId = getLowerBaseModelName(nameAsId.id);
  return (
    /(\w+-)?deepseek-v3(?:\.\d|-\d)(?:(\.|-)(?!speciale$)\w+)?$/.test(nameModelId) ||
    nameModelId.includes('deepseek-chat-v3.1') ||
    nameModelId.includes('deepseek-chat')
  );
}

export function isFunctionCallingModel(model?: CherryModelInput): boolean {
  if (!model || isEmbeddingModel(model) || isRerankModel(model) || isTextToImageModel(model)) return false;
  const ov = pickOverride(model, 'function_calling');
  if (ov !== undefined) return ov;

  const pid = normProviderId(model.providerId);
  const modelId = getLowerBaseModelName(model.id);

  if (pid === 'doubao' || modelId.includes('doubao')) {
    return FUNCTION_CALLING_REGEX.test(modelId) || FUNCTION_CALLING_REGEX.test(model.name);
  }

  // Cherry: 深度混合推理模型（DeepSeek v3.1/v3.2）对部分 provider 默认不支持函数调用；这里保留关键分支
  if (isDeepSeekHybridInferenceModel(model)) {
    if (pid === 'dashscope' || pid === 'doubao') return false;
    return true;
  }

  return FUNCTION_CALLING_REGEX.test(modelId);
}

// -----------------------------
// reasoning (from Cherry: only for classification)
// -----------------------------

const REASONING_REGEX =
  /^(?!.*-non-reasoning\b)(o\d+(?:-[\w-]+)?|.*\b(?:reasoning|reasoner|thinking|think)\b.*|.*-[rR]\d+.*|.*\bqwq(?:-[\w-]+)?\b.*|.*\bhunyuan-t1(?:-[\w-]+)?\b.*|.*\bglm-zero-preview\b.*|.*\bgrok-(?:3-mini|4|4-fast)(?:-[\w-]+)?\b.*)$/i;

function isOpenAIReasoningModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id, '/');
  return isSupportedReasoningEffortOpenAIModel(model) || modelId.includes('o1');
}

function isSupportedReasoningEffortOpenAIModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id);
  const isGPT5SeriesModel = modelId.includes('gpt-5') && !modelId.includes('gpt-5.1') && !modelId.includes('gpt-5.2');
  const isGPT51SeriesModel = modelId.includes('gpt-5.1');
  const isGPT52SeriesModel = modelId.includes('gpt-5.2');
  return (
    (modelId.includes('o1') && !(modelId.includes('o1-preview') || modelId.includes('o1-mini'))) ||
    modelId.includes('o3') ||
    modelId.includes('o4') ||
    modelId.includes('gpt-oss') ||
    ((isGPT5SeriesModel || isGPT51SeriesModel || isGPT52SeriesModel) && !modelId.includes('chat'))
  );
}

function isClaudeReasoningModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id, '/');
  return (
    modelId.includes('claude-3-7-sonnet') ||
    modelId.includes('claude-3.7-sonnet') ||
    modelId.includes('claude-sonnet-4') ||
    modelId.includes('claude-opus-4') ||
    modelId.includes('claude-haiku-4')
  );
}

function isSupportedThinkingTokenGeminiModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id, '/');
  const GEMINI_THINKING_MODEL_REGEX =
    /gemini-(?:2\.5.*(?:-latest)?|3(?:\.\d+)?-(?:flash|pro)(?:-preview)?|flash-latest|pro-latest|flash-lite-latest)(?:-[\w-]+)*$/i;
  if (!GEMINI_THINKING_MODEL_REGEX.test(modelId)) return false;
  if (modelId.includes('gemini-3-pro-image')) return true;
  if (modelId.includes('image') || modelId.includes('tts')) return false;
  return true;
}

function isGeminiReasoningModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id);
  if (modelId.startsWith('gemini') && modelId.includes('thinking')) return true;
  return isSupportedThinkingTokenGeminiModel(model);
}

function isSupportedThinkingTokenQwenModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id, '/');
  if (modelId.includes('coder')) return false;
  if (modelId.startsWith('qwen3')) {
    if (modelId.includes('instruct') || modelId.includes('thinking') || modelId.includes('qwen3-max')) return false;
    return true;
  }
  return [
    'qwen-plus',
    'qwen-plus-latest',
    'qwen-plus-0428',
    'qwen-plus-2025-04-28',
    'qwen-plus-0714',
    'qwen-plus-2025-07-14',
    'qwen-plus-2025-07-28',
    'qwen-plus-2025-09-11',
    'qwen-turbo',
    'qwen-turbo-latest',
    'qwen-turbo-0428',
    'qwen-turbo-2025-04-28',
    'qwen-turbo-0715',
    'qwen-turbo-2025-07-15',
    'qwen-flash',
    'qwen-flash-2025-07-28',
  ].includes(modelId);
}

function isQwenReasoningModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id, '/');
  if (modelId.startsWith('qwen3') && modelId.includes('thinking')) return true;
  if (isSupportedThinkingTokenQwenModel(model)) return true;
  if (modelId.includes('qwq') || modelId.includes('qvq')) return true;
  return false;
}

function isSupportedThinkingTokenDoubaoModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id, '/');
  const DOUBAO_THINKING_MODEL_REGEX =
    /doubao-(?:1[.-]5-thinking-vision-pro|1[.-]5-thinking-pro-m|seed-1[.-][68](?:-flash)?(?!-(?:thinking)(?:-|$))|seed-code(?:-preview)?(?:-\d+)?)(?:-[\w-]+)*/i;
  return DOUBAO_THINKING_MODEL_REGEX.test(modelId) || DOUBAO_THINKING_MODEL_REGEX.test(model.name);
}

function isGrokReasoningModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id, '/');
  if (modelId.includes('grok-3-mini')) return true;
  // openrouter 特判 grok-4-fast；在我们这里用 providerId 字符串近似
  const pid = normProviderId(model.providerId);
  if (pid === 'openrouter' && modelId.includes('grok-4-fast')) return true;
  if (modelId.includes('grok-4') && !modelId.includes('non-reasoning')) return true;
  return false;
}

function isHunyuanReasoningModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id, '/');
  return modelId.includes('hunyuan-a13b') || modelId.includes('hunyuan-t1');
}

function isSupportedReasoningEffortPerplexityModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id, '/');
  return modelId.includes('sonar-deep-research');
}

function isPerplexityReasoningModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id, '/');
  return isSupportedReasoningEffortPerplexityModel(model) || (modelId.includes('reasoning') && !modelId.includes('non-reasoning'));
}

function isZhipuReasoningModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id, '/');
  return ['glm-4.5', 'glm-4.6'].some((id) => modelId.includes(id)) || modelId.includes('glm-z1');
}

function isStepReasoningModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id, '/');
  return modelId.includes('step-3') || modelId.includes('step-r1-v-mini');
}

function isLingReasoningModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id, '/');
  return ['ring-1t', 'ring-mini', 'ring-flash'].some((id) => modelId.includes(id));
}

function isMiniMaxReasoningModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id, '/');
  return (['minimax-m1', 'minimax-m2'] as const).some((id) => modelId.includes(id));
}

function isMiMoReasoningModel(model: CherryModelInput): boolean {
  const modelId = getLowerBaseModelName(model.id, '/');
  return ['mimo-v2-flash'].some((id) => modelId.includes(id));
}

export function isReasoningModel(model?: CherryModelInput): boolean {
  if (!model || isEmbeddingModel(model) || isRerankModel(model) || isTextToImageModel(model)) return false;
  const ov = pickOverride(model, 'reasoning');
  if (ov !== undefined) return ov;

  const modelId = getLowerBaseModelName(model.id);
  const pid = normProviderId(model.providerId);

  if (pid === 'doubao' || modelId.includes('doubao')) {
    return (
      REASONING_REGEX.test(modelId) ||
      REASONING_REGEX.test(model.name) ||
      isSupportedThinkingTokenDoubaoModel(model) ||
      isDeepSeekHybridInferenceModel(model) ||
      false
    );
  }

  if (
    isClaudeReasoningModel(model) ||
    isOpenAIReasoningModel(model) ||
    isGeminiReasoningModel(model) ||
    isQwenReasoningModel(model) ||
    isGrokReasoningModel(model) ||
    isHunyuanReasoningModel(model) ||
    isPerplexityReasoningModel(model) ||
    isZhipuReasoningModel(model) ||
    isStepReasoningModel(model) ||
    isDeepSeekHybridInferenceModel(model) ||
    isLingReasoningModel(model) ||
    isMiniMaxReasoningModel(model) ||
    isMiMoReasoningModel(model) ||
    modelId.includes('magistral') ||
    modelId.includes('pangu-pro-moe') ||
    modelId.includes('seed-oss') ||
    modelId.includes('deepseek-v3.2-speciale')
  ) {
    return true;
  }

  return REASONING_REGEX.test(modelId) || false;
}

// -----------------------------
// web search (Cherry: simplified mapping to providerId/platformType)
// -----------------------------

const PERPLEXITY_SEARCH_MODELS = ['sonar-pro', 'sonar', 'sonar-reasoning', 'sonar-reasoning-pro', 'sonar-deep-research'] as const;

const GEMINI_SEARCH_REGEX = new RegExp(
  'gemini-(?:2(?!.*-image-preview).*(?:-latest)?|3(?:\\.\\d+)?-(?:flash|pro)(?:-(?:image-)?preview)?|flash-latest|pro-latest|flash-lite-latest)(?:-[\\w-]+)*$',
  'i'
);

function isOpenAIWebSearchModelId(modelId: string): boolean {
  const id = getLowerBaseModelName(modelId);
  return (
    id.includes('gpt-4o-search-preview') ||
    id.includes('gpt-4o-mini-search-preview') ||
    (id.includes('gpt-4.1') && !id.includes('gpt-4.1-nano')) ||
    (id.includes('gpt-4o') && !id.includes('gpt-4o-image')) ||
    id.includes('o3') ||
    id.includes('o4') ||
    (id.includes('gpt-5') && !id.includes('chat'))
  );
}

export function isWebSearchModel(model: CherryModelInput): boolean {
  if (!model || isEmbeddingModel(model) || isRerankModel(model) || isTextToImageModel(model)) return false;
  const ov = pickOverride(model, 'web_search');
  if (ov !== undefined) return ov;

  const pid = normProviderId(model.providerId);
  const modelId = getLowerBaseModelName(model.id, '/');

  // Perplexity
  if (pid === 'perplexity') return (PERPLEXITY_SEARCH_MODELS as readonly string[]).includes(modelId);

  // Aihubmix 特例：允许 Gemini（非 -search 结尾）与 OpenAI websearch
  if (pid === 'aihubmix') {
    if (!modelId.endsWith('-search') && GEMINI_SEARCH_REGEX.test(modelId)) return true;
    if (isOpenAIWebSearchModelId(modelId)) return true;
    return false;
  }

  // Gemini / Vertex：Gemini regex
  if (pid === 'gemini' || pid === 'vertexai') return GEMINI_SEARCH_REGEX.test(modelId);

  // Hunyuan / Zhipu / Dashscope 的特殊逻辑
  if (pid === 'hunyuan') return modelId !== 'hunyuan-lite';
  if (pid === 'zhipu') return modelId.startsWith('glm-4-');
  if (pid === 'dashscope') {
    const models = ['qwen-turbo', 'qwen-max', 'qwen-plus', 'qwq', 'qwen-flash', 'qwen3-max'];
    return models.some((i) => modelId.startsWith(i));
  }

  // OpenRouter / Grok：默认 true
  if (pid === 'openrouter' || pid === 'grok') return true;

  // OpenAI compat / new-api：Gemini 或 OpenAI websearch id 命中
  // 我们用 platformType=openai/other 近似“OpenAI 兼容”
  const pt = (model.platformType ?? '').trim().toLowerCase();
  const isOpenAiCompat = pt === 'openai' || pt === 'other' || pid === 'new-api' || pid === 'cherryin';
  if (isOpenAiCompat) {
    if (GEMINI_SEARCH_REGEX.test(modelId) || isOpenAIWebSearchModelId(modelId)) return true;
  }

  return false;
}

// -----------------------------
// public: tags + tab filtering
// -----------------------------

export type CherryModelTagKey = 'reasoning' | 'vision' | 'websearch' | 'function_calling' | 'embedding' | 'rerank' | 'free';

export function isFreeModel(model: CherryModelInput): boolean {
  const pid = normProviderId(model.providerId);
  if (pid === 'cherryai') return true;
  return `${model.id}${model.name}`.toLowerCase().includes('free');
}

export function getCherryPresetTags(model: CherryModelInput): CherryModelTagKey[] {
  const out: CherryModelTagKey[] = [];
  if (isVisionModel(model)) out.push('vision');
  if (isEmbeddingModel(model)) out.push('embedding');
  if (isReasoningModel(model)) out.push('reasoning');
  if (isFunctionCallingModel(model)) out.push('function_calling');
  if (isWebSearchModel(model)) out.push('websearch');
  if (isRerankModel(model)) out.push('rerank');
  if (isFreeModel(model)) out.push('free');
  return out;
}

export type CherryAvailableTab = 'all' | 'reasoning' | 'vision' | 'web' | 'free' | 'embedding' | 'rerank' | 'tools';

export function matchCherryAvailableTab(tab: CherryAvailableTab, model: CherryModelInput): boolean {
  if (tab === 'all') return true;
  if (tab === 'vision') return isVisionModel(model);
  if (tab === 'embedding') return isEmbeddingModel(model);
  if (tab === 'rerank') return isRerankModel(model);
  if (tab === 'tools') return isFunctionCallingModel(model);
  if (tab === 'web') return isWebSearchModel(model);
  if (tab === 'free') return isFreeModel(model);
  // reasoning tab（Cherry：严格 isReasoningModel）
  return isReasoningModel(model);
}


