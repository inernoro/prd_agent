/**
 * 知识库 tag 配色调色板。
 *
 * - 8 色（红/橙/黄/绿/青/蓝/紫/灰），与 Finder 标签色系同源
 * - 默认按 tag 名做稳定哈希自动分色，相同 tag 永远同色
 * - 后续可叠加用户自定义覆盖（DocumentStore.tagColors map）
 */

export type TagColorKey = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'gray';

export interface TagColorSpec {
  key: TagColorKey;
  label: string;
  dot: string;
  text: string;
  bg: string;
  border: string;
}

export const TAG_PALETTE: Record<TagColorKey, TagColorSpec> = {
  red:    { key: 'red',    label: '红', dot: '#ef4444', text: 'rgba(252,165,165,0.95)', bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.22)'  },
  orange: { key: 'orange', label: '橙', dot: '#f97316', text: 'rgba(253,186,116,0.95)', bg: 'rgba(249,115,22,0.12)', border: 'rgba(249,115,22,0.22)' },
  yellow: { key: 'yellow', label: '黄', dot: '#eab308', text: 'rgba(253,224,71,0.95)',  bg: 'rgba(234,179,8,0.12)',  border: 'rgba(234,179,8,0.22)'  },
  green:  { key: 'green',  label: '绿', dot: '#22c55e', text: 'rgba(134,239,172,0.95)', bg: 'rgba(34,197,94,0.12)',  border: 'rgba(34,197,94,0.22)'  },
  teal:   { key: 'teal',   label: '青', dot: '#14b8a6', text: 'rgba(94,234,212,0.95)',  bg: 'rgba(20,184,166,0.12)', border: 'rgba(20,184,166,0.22)' },
  blue:   { key: 'blue',   label: '蓝', dot: '#3b82f6', text: 'rgba(147,197,253,0.95)', bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.22)' },
  purple: { key: 'purple', label: '紫', dot: '#a855f7', text: 'rgba(216,180,254,0.95)', bg: 'rgba(168,85,247,0.12)', border: 'rgba(168,85,247,0.22)' },
  gray:   { key: 'gray',   label: '灰', dot: '#94a3b8', text: 'rgba(203,213,225,0.9)',  bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.22)' },
};

const PALETTE_ORDER: TagColorKey[] = ['blue', 'purple', 'green', 'orange', 'red', 'teal', 'yellow', 'gray'];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * 获取 tag 颜色：优先用户覆盖（overrides[tag]），否则按 tag 名哈希自动分配。
 * 同名 tag 永远同色，视觉一致。
 */
export function getTagColor(tag: string, overrides?: Record<string, TagColorKey | undefined>): TagColorSpec {
  const overridden = overrides?.[tag];
  if (overridden && TAG_PALETTE[overridden]) return TAG_PALETTE[overridden];
  const idx = hashString(tag) % PALETTE_ORDER.length;
  return TAG_PALETTE[PALETTE_ORDER[idx]];
}

/**
 * 显示用截断：默认 tag 名超过 2 个汉字（或 4 个 ASCII 字符宽度）就截断为 `xx...`。
 * 完整名通过 title 属性展示。
 */
export function truncateTagDisplay(tag: string, maxChars = 2): string {
  // 中日韩字符按 1 字宽，其他按 0.5 字宽算
  let width = 0;
  let result = '';
  for (const ch of tag) {
    const w = /[\u4e00-\u9fff\u3040-\u30ff]/.test(ch) ? 1 : 0.5;
    if (width + w > maxChars) {
      return result + '…';
    }
    width += w;
    result += ch;
  }
  return result;
}
