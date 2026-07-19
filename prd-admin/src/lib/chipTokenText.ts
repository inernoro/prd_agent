/**
 * 视觉创作 composer 的 chip 文本 token（Lovart 形态）。
 *
 * 复制/剪切时把输入框里的图片 chip 序列化为可携带的纯文本 token：
 *   [@image:#1:img-3-ab12:https://example.com/a.png] 拿着 [@image:#2:...] ...
 * 粘贴时按 token 还原为 chip（仅当 canvasKey 命中当前画布可选图片集时——
 * 不在集内的 token 保持纯文本，绝不构造幻觉引用）。
 *
 * 纯函数模块，供 vitest 单测覆盖；Lexical 侧接线见 RichComposer/index.tsx。
 */

export interface ChipTokenSegText {
  type: 'text';
  text: string;
}

export interface ChipTokenSegChip {
  type: 'chip';
  refId: number;
  canvasKey: string;
  src: string;
  /** 原始 token 文本（canvasKey 未命中时按原样保留） */
  raw: string;
}

export type ChipTokenSeg = ChipTokenSegText | ChipTokenSegChip;

/** 生成单个 chip token。canvasKey 由 uid 生成（不含 ":" / "]"），src 不含 "]"。 */
export function chipToken(refId: number, canvasKey: string, src: string): string {
  return `[@image:#${refId}:${canvasKey}:${src}]`;
}

/** token 识别（canvasKey 段禁 ":"，src 段吃到"]"前——URL 里的 ":" 合法） */
const CHIP_TOKEN_RE = /\[@image:#(\d+):([^:\]]+):([^\]]*)\]/g;

/** 快速判断一段文本是否含 chip token（粘贴分流用） */
export function hasChipToken(text: string): boolean {
  CHIP_TOKEN_RE.lastIndex = 0;
  return CHIP_TOKEN_RE.test(text);
}

/** 把含 token 的文本切成 文本/chip 段序列（保序，含空文本段剔除） */
export function parseChipTokenText(text: string): ChipTokenSeg[] {
  const segs: ChipTokenSeg[] = [];
  const re = new RegExp(CHIP_TOKEN_RE.source, CHIP_TOKEN_RE.flags);
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ type: 'text', text: text.slice(last, m.index) });
    segs.push({
      type: 'chip',
      refId: parseInt(m[1], 10),
      canvasKey: m[2],
      src: m[3],
      raw: m[0],
    });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ type: 'text', text: text.slice(last) });
  return segs;
}

/** 内联 @imgN 标记（chip 的 getTextContent 形态；(?!\d) 防 @img1 命中 @img12） */
export const INLINE_IMG_MARK_RE = /@img(\d+)(?!\d)/g;

/**
 * 把选区纯文本（chip 已按 getTextContent 变成 @imgN）升级为 token 文本。
 * chipMeta: refId -> {canvasKey, src}（从选区内真实 chip 节点收集）。
 * 未命中 meta 的 @imgN（用户手敲的裸文本）保持原样。
 */
export function inlineMarksToTokens(
  text: string,
  chipMeta: ReadonlyMap<number, { canvasKey: string; src: string }>,
): string {
  return text.replace(new RegExp(INLINE_IMG_MARK_RE.source, INLINE_IMG_MARK_RE.flags), (m, id) => {
    const refId = parseInt(id, 10);
    const meta = chipMeta.get(refId);
    return meta ? chipToken(refId, meta.canvasKey, meta.src) : m;
  });
}
