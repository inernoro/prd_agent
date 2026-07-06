/**
 * 流式 JSON 增量解析器 —— 把 LLM 正在生成的原始 JSON 数组文本，
 * 实时解析成「节点卡片的形状」供占位卡渲染（产物即体验：
 * 等待期主视觉必须是产物本身在生长，禁止把 token 流裸露给用户）。
 *
 * 后端 explore / emerge 的输出契约（EmergenceService.Build*SystemPrompt）：
 * 严格 JSON 数组，每个对象含 title / description / groundingContent /
 * techPlan / valueScore / difficultyScore / tags 等字段，无嵌套对象。
 *
 * 解析必须容错：文本随时截断在任何字符上（半个转义符、未闭合字符串、
 * markdown 围栏、数组中途）。解析失败时退化为"什么都没解析到"，
 * 由占位卡回落到 shimmer，绝不抛错。
 */

export interface LiveNodeDraft {
  /** 已流出的标题（可能仍在打字中） */
  title?: string;
  /** 标题是否已闭合（闭合后光标移到下一个字段） */
  titleDone: boolean;
  /** 已流出的描述（可能仍在打字中） */
  description?: string;
  descriptionDone: boolean;
  valueScore?: number;
  difficultyScore?: number;
  /** 已完整解析出的标签 */
  tags: string[];
  /**
   * 标题/描述之外、当前正在流式输出的长字段（现实锚点/实现思路/假设条件…）：
   * 用中文标签 + 文字尾巴渲染成卡片的次要信息区，维持"一直有字在长"的体感。
   */
  activeField?: { label: string; text: string };
  /** 是否解析出了任何可展示内容 */
  hasContent: boolean;
}

export interface LiveNodePreview {
  /** 是否解析出了任何可展示内容（false → 占位卡继续 shimmer） */
  hasAny: boolean;
  /** 已完整闭合的节点标题（顺序即生成顺序） */
  doneTitles: string[];
  /** 当前正在生成中的节点草稿；两个对象之间的空档为 null */
  draft: LiveNodeDraft | null;
}

/** 字段名 → 中文标签。null = 该字段有专属渲染位（标题/描述）或不值得展示 */
const FIELD_LABELS: Record<string, string | null> = {
  title: null,
  description: null,
  groundingContent: '现实锚点',
  groundingType: null,
  groundingRef: '锚点引用',
  techPlan: '实现思路',
  parentTitles: '组合来源',
  bridgeAssumptions: '假设条件',
  missingCapabilities: '缺失能力',
  tags: '标签',
};

/** 把 JSON 字符串体（不含首尾引号）还原成显示文本；截断的转义符先剪掉 */
function unescapeJsonBody(body: string): string {
  let t = body;
  // 结尾悬挂的单个反斜杠 = 被截断的转义序列，剪掉避免 JSON.parse 失败
  if (/(^|[^\\])(\\\\)*\\$/.test(t)) t = t.slice(0, -1);
  try {
    return JSON.parse(`"${t}"`) as string;
  } catch {
    return t
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, ' ')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

/**
 * 扫描原文，按「对象」切分：返回已闭合的对象文本 + 结尾未闭合的对象文本。
 * 用字符级状态机跟踪字符串/转义，不怕字符串里出现大括号。
 * 契约里无嵌套对象，但 depth 计数天然兼容嵌套。
 */
function splitObjects(raw: string): { complete: string[]; partial: string | null } {
  const complete: string[] = [];
  let inStr = false;
  let esc = false;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      if (depth > 0) depth--;
      if (depth === 0 && start >= 0) {
        complete.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return { complete, partial: start >= 0 ? raw.slice(start) : null };
}

/** 从一段完整对象文本里提取 title（JSON.parse 优先，失败退化 regex） */
function titleOf(objText: string): string | null {
  try {
    const obj = JSON.parse(objText) as { title?: unknown };
    if (typeof obj.title === 'string' && obj.title.trim()) return obj.title.trim();
  } catch { /* 容错：走 regex */ }
  const m = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(objText);
  return m ? unescapeJsonBody(m[1]).trim() || null : null;
}

/** 提取 `["a", "b"]` 数组体里的完整字符串 */
function stringsInArrayBody(body: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const s = unescapeJsonBody(m[1]).trim();
    if (s) out.push(s);
  }
  return out;
}

/** 解析未闭合对象文本 → 当前节点草稿 */
function parseDraft(partial: string): LiveNodeDraft {
  const draft: LiveNodeDraft = { titleDone: false, descriptionDone: false, tags: [], hasContent: false };

  // 1) 已闭合的字符串字段
  const strFields: Record<string, string> = {};
  const strRe = /"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = strRe.exec(partial))) strFields[m[1]] = unescapeJsonBody(m[2]);
  if (strFields.title !== undefined) {
    draft.title = strFields.title;
    draft.titleDone = true;
  }
  if (strFields.description !== undefined) {
    draft.description = strFields.description;
    draft.descriptionDone = true;
  }

  // 2) 数字字段
  const numRe = /"(valueScore|difficultyScore)"\s*:\s*(\d+(?:\.\d+)?)/g;
  while ((m = numRe.exec(partial))) {
    const v = Math.round(parseFloat(m[2]));
    if (m[1] === 'valueScore') draft.valueScore = v;
    else draft.difficultyScore = v;
  }

  // 3) 已闭合的数组字段（当前只展示 tags）
  const arrRe = /"(\w+)"\s*:\s*\[([^\]]*)\]/g;
  while ((m = arrRe.exec(partial))) {
    if (m[1] === 'tags') draft.tags = stringsInArrayBody(m[2]);
  }

  // 4) 正在流式输出（未闭合）的字符串：直接接在字段冒号后，或位于数组内。
  //    结尾允许悬挂半个转义符（\\?$），unescapeJsonBody 会把它剪掉
  const ipDirect = /"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)\\?$/.exec(partial);
  const ipInArray = /"(\w+)"\s*:\s*\[[^\]]*?"((?:[^"\\]|\\.)*)\\?$/.exec(partial);
  const ip = ipDirect ?? ipInArray;
  if (ip) {
    const key = ip[1];
    const text = unescapeJsonBody(ip[2]);
    if (key === 'title') {
      draft.title = text;
      draft.titleDone = false;
    } else if (key === 'description') {
      draft.description = text;
      draft.descriptionDone = false;
    } else {
      const label = FIELD_LABELS[key];
      if (label && text.trim()) draft.activeField = { label, text };
    }
  }

  draft.hasContent = Boolean(
    (draft.title && draft.title.trim())
    || (draft.description && draft.description.trim())
    || draft.activeField
    || draft.valueScore !== undefined
    || draft.tags.length > 0,
  );
  return draft;
}

/**
 * 稳定尾窗：给「底部锚定日志窗」提供渲染文本。
 * 与"每 chunk 重截最后 N 字符"的滑动窗口不同，裁剪点按 step 步进——
 * 同一步进区间内窗口起点完全不变，文字只在末尾追加、绝不整段重排
 * （重排会让等待区看起来像乱码在折叠收缩）。
 * 裁剪点向后寻最近的空白/换行，避免切在单词或代理对中间。
 */
export function stableThinkingWindow(text: string, keep = 1000, step = 400): string {
  if (text.length <= keep + step) return text;
  let cut = Math.floor((text.length - keep) / step) * step;
  const limit = Math.min(cut + 80, text.length);
  let i = cut;
  while (i < limit && !/\s/.test(text[i])) i++;
  if (i < limit) cut = i;
  return text.slice(cut);
}

/** 主入口：LLM 原始累积文本 → 实时节点预览 */
export function parseLiveNodePreview(raw: string | undefined | null): LiveNodePreview {
  const text = (raw ?? '').trim();
  if (!text) return { hasAny: false, doneTitles: [], draft: null };

  const { complete, partial } = splitObjects(text);
  const doneTitles: string[] = [];
  for (const objText of complete) {
    const t = titleOf(objText);
    if (t) doneTitles.push(t);
  }
  const draft = partial ? parseDraft(partial) : null;
  const effectiveDraft = draft?.hasContent ? draft : null;
  return {
    hasAny: doneTitles.length > 0 || effectiveDraft !== null,
    doneTitles,
    draft: effectiveDraft,
  };
}
