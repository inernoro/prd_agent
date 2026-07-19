/**
 * 视觉创作消息展示层清洗（display layer）
 *
 * 背景：历史上"发给模型的 prompt"（含生图意图前缀 + 【引用图片（按顺序）】文字块 +
 * "- @imgN: 文件名" 行）会泄漏进 image_master_messages 的用户消息里，
 * 用户在聊天记录中看到一大段文字版引用信息。
 *
 * 本模块只影响"展示"：
 * - 存储内容保持原样（兼容旧消息）；
 * - 渲染前剥离模型层标记，把引用统一还原为 @imgN 标记，
 *   由 MessageContentRenderer 渲染为视觉 chip（缩略图 + 短标签）。
 *
 * 纯函数，供 vitest 单测覆盖。
 */

import { cleanDisplayTitle } from './visualAgentPromptUtils';

export interface ParsedVisualMessageDisplay {
  /** 清理后的展示文本（可能仍含内联 @imgN 标记，就地渲染为 chip） */
  text: string;
  /** 仅出现在被剥离的引用块中、正文里没有的引用序号（按块内顺序，用于渲染顶部 chip 行） */
  blockRefIds: number[];
}

/** 生图意图前缀（模型层 prompt 前缀，禁止出现在展示层） */
const GENERATE_PREFIX_RE = /^\s*Generate an image based on the following description:\s*/i;
/** 【引用图片（按顺序）】/【引用图片】等块头 */
const REF_BLOCK_HEADER_RE = /【[^】]*引用图片[^】]*】/g;
/* "- @imgN: label" 引用行的剥离已收窄到【引用图片】块头之后的连续行内联判定
 *（见 parseVisualMessageDisplay 步骤 2）——全局整行剥离会误杀用户手写的
 * "- @img1: 保持面部不变" 普通列表行。 */
/** 裸 (@size:...) / (@model:...) 元数据 token。
 *  值本身可能带一层括号（如模型池名"默认图像生成池 (stub-image)"），
 *  用 [^)]* 会在第一个 ) 截断、剥完残留一个 ")" 在气泡开头——需容忍一层嵌套。 */
const META_TOKEN_RE = /\(\s*@(?:size|model)\s*:(?:[^()]|\([^()]*\))*\)/gi;
/** 内联 @imgN 引用（(?!\d) 防止 @img1 命中 @img12 前缀） */
const INLINE_REF_RE = /@img(\d+)(?!\d)/g;

function newRe(re: RegExp): RegExp {
  // 每次调用重建，避免共享 lastIndex 状态
  return new RegExp(re.source, re.flags);
}

/**
 * 把（可能被模型层 prompt 污染的）消息内容解析为展示层内容。
 *
 * 处理：
 * 1. 剥离 "Generate an image based on the following description:" 前缀（可重复出现）
 * 2. 收集并剥离 【引用图片…】 块头与 "- @imgN: 文件名" 行（文件名绝不进入展示）
 * 3. 剥离裸 (@size:...) / (@model:...) token
 * 4. 折叠多余空行
 * 5. 引用块中出现、但正文没有内联出现的 refId 汇总到 blockRefIds（渲染为顶部 chip 行）
 */
export function parseVisualMessageDisplay(raw: string): ParsedVisualMessageDisplay {
  let s = String(raw ?? '');
  if (!s.trim()) return { text: '', blockRefIds: [] };

  // 1. 生图意图前缀（防御性循环：历史内容可能叠加多层）
  let guard = 0;
  while (GENERATE_PREFIX_RE.test(s) && guard < 5) {
    s = s.replace(GENERATE_PREFIX_RE, '');
    guard += 1;
  }

  // 2. 收集并剥离【引用图片…】块：块头 + 紧随其后的连续 "- @imgN: 文件名" 行。
  //    只剥真实生成块（Codex P2）——用户手写的 "- @img1: 保持面部不变" 这类
  //    普通列表行不在块头之后，整行保留（指令文字不丢，@imgN 就地渲染 chip）。
  const blockIds: number[] = [];
  const seen = new Set<number>();
  {
    const lines = s.split('\n');
    const kept: string[] = [];
    let inBlock = false;
    for (const line of lines) {
      const headerRe = newRe(REF_BLOCK_HEADER_RE);
      if (headerRe.test(line)) {
        inBlock = true;
        // 块头可能与正文同行（历史拼接）：剥块头标记，保留同行其余文字
        const rest = line.replace(newRe(REF_BLOCK_HEADER_RE), ' ').trim();
        if (rest) kept.push(rest);
        continue;
      }
      const refLine = /^\s*-\s*@?img(\d+)\s*[:：].*$/i.exec(line);
      if (inBlock && refLine) {
        const id = parseInt(refLine[1], 10);
        if (Number.isFinite(id) && id > 0 && !seen.has(id)) {
          seen.add(id);
          blockIds.push(id);
        }
        continue; // 块内引用行整行剥离（文件名绝不进展示）
      }
      // 任何非引用行（含空行）终结当前块
      inBlock = false;
      kept.push(line);
    }
    s = kept.join('\n');
  }

  // 3. 裸元数据 token
  s = s.replace(newRe(META_TOKEN_RE), ' ');

  // 3.5 历史消息形如 "(@size:...) (@model:...) Generate an image..."：
  // 前缀藏在元数据 token 之后，步骤 1 匹配不到，剥完 token 再清一轮
  guard = 0;
  while (GENERATE_PREFIX_RE.test(s) && guard < 5) {
    s = s.replace(GENERATE_PREFIX_RE, '');
    guard += 1;
  }

  // 4. 折叠空白：行内多空格合一、3+ 连续换行降为 2、去首尾
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // 5. 正文内已内联出现的 refId 不再进 blockRefIds（避免重复渲染）
  const inline = new Set<number>();
  const inlineRe = newRe(INLINE_REF_RE);
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(s)) !== null) {
    const id = parseInt(m[1], 10);
    if (Number.isFinite(id) && id > 0) inline.add(id);
  }
  const blockRefIds = blockIds.filter((id) => !inline.has(id));

  return { text: s, blockRefIds };
}

/** 图片扩展名后缀（用于剥掉"原始文件名"的扩展名） */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg|avif|heic|tiff?)$/i;

/**
 * chip 标签清洗：绝不显示"带扩展名的原始文件名"。
 *
 * - 以图片扩展名结尾 → 先剥扩展名；纯文件名主干（无空格长 token）截短为前 8 位
 * - 其他文本 → cleanDisplayTitle 剥标记去重
 * - 清洗后为空 → "图N" 中性标签
 */
export function cleanChipLabel(label: string | null | undefined, refId: number): string {
  const raw = String(label ?? '').trim();
  const hadExt = IMAGE_EXT_RE.test(raw);
  const base = raw.replace(IMAGE_EXT_RE, '');
  const cleaned = cleanDisplayTitle(base, 60);
  if (cleaned) {
    if (hadExt && /^\S+$/.test(cleaned) && cleaned.length > 8) {
      return `${cleaned.slice(0, 8)}…`;
    }
    return cleaned;
  }
  return refId > 0 ? `图${refId}` : '图片';
}
