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
  red:    { key: 'red',    label: '红', dot: 'var(--tag-red-solid)',    text: 'var(--semantic-danger-text)',  bg: 'var(--semantic-danger-soft)',  border: 'var(--semantic-danger-border)' },
  orange: { key: 'orange', label: '橙', dot: 'var(--tag-orange-solid)', text: 'var(--semantic-orange-text)',  bg: 'var(--semantic-orange-soft)',  border: 'var(--semantic-orange-border)' },
  yellow: { key: 'yellow', label: '黄', dot: 'var(--tag-yellow-solid)', text: 'var(--semantic-warning-text)', bg: 'var(--semantic-warning-soft)', border: 'var(--semantic-warning-border)' },
  green:  { key: 'green',  label: '绿', dot: 'var(--tag-green-solid)',  text: 'var(--semantic-success-text)', bg: 'var(--semantic-success-soft)', border: 'var(--semantic-success-border)' },
  teal:   { key: 'teal',   label: '青', dot: 'var(--tag-teal-solid)',   text: 'var(--semantic-cyan-text)',    bg: 'var(--semantic-cyan-soft)',    border: 'var(--semantic-cyan-border)' },
  blue:   { key: 'blue',   label: '蓝', dot: 'var(--tag-blue-solid)',   text: 'var(--semantic-info-text)',    bg: 'var(--semantic-info-soft)',    border: 'var(--semantic-info-border)' },
  purple: { key: 'purple', label: '紫', dot: 'var(--tag-purple-solid)', text: 'var(--semantic-purple-text)',  bg: 'var(--semantic-purple-soft)',  border: 'var(--semantic-purple-border)' },
  gray:   { key: 'gray',   label: '灰', dot: 'var(--tag-gray-solid)',   text: 'var(--semantic-neutral-text)', bg: 'var(--semantic-neutral-soft)', border: 'var(--semantic-neutral-border)' },
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
