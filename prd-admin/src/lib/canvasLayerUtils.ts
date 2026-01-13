/**
 * Canvas 图层操作工具函数
 * 
 * 用于调整画布元素的图层顺序（z-index）
 * canvas 数组的顺序决定渲染顺序：后面的元素在上层
 */

export interface LayerItem {
  key: string;
  [key: string]: unknown;
}

/**
 * 上移一层：将选中的元素在数组中后移一位
 * 多选时保持相对顺序
 */
export function moveUp<T extends LayerItem>(items: T[], selectedKeys: string[]): T[] {
  if (items.length === 0 || selectedKeys.length === 0) return items;
  
  const result = [...items];
  const selectedSet = new Set(selectedKeys);
  
  // 从后向前遍历，避免移动后影响后续处理
  for (let i = result.length - 2; i >= 0; i--) {
    const item = result[i];
    if (selectedSet.has(item.key)) {
      const next = result[i + 1];
      // 如果下一个也是选中的，跳过（保持相对顺序）
      if (selectedSet.has(next.key)) continue;
      // 交换位置
      result[i] = next;
      result[i + 1] = item;
    }
  }
  
  return result;
}

/**
 * 下移一层：将选中的元素在数组中前移一位
 * 多选时保持相对顺序
 */
export function moveDown<T extends LayerItem>(items: T[], selectedKeys: string[]): T[] {
  if (items.length === 0 || selectedKeys.length === 0) return items;
  
  const result = [...items];
  const selectedSet = new Set(selectedKeys);
  
  // 从前向后遍历
  for (let i = 1; i < result.length; i++) {
    const item = result[i];
    if (selectedSet.has(item.key)) {
      const prev = result[i - 1];
      // 如果前一个也是选中的，跳过（保持相对顺序）
      if (selectedSet.has(prev.key)) continue;
      // 交换位置
      result[i] = prev;
      result[i - 1] = item;
    }
  }
  
  return result;
}

/**
 * 置于顶层：将选中的元素移动到数组末尾
 * 多选时保持相对顺序
 */
export function bringToFront<T extends LayerItem>(items: T[], selectedKeys: string[]): T[] {
  if (items.length === 0 || selectedKeys.length === 0) return items;
  
  const selectedSet = new Set(selectedKeys);
  const unselected: T[] = [];
  const selected: T[] = [];
  
  // 分离选中和未选中的元素，保持各自的相对顺序
  for (const item of items) {
    if (selectedSet.has(item.key)) {
      selected.push(item);
    } else {
      unselected.push(item);
    }
  }
  
  // 未选中的在前，选中的在后（顶层）
  return [...unselected, ...selected];
}

/**
 * 置于底层：将选中的元素移动到数组开头
 * 多选时保持相对顺序
 */
export function sendToBack<T extends LayerItem>(items: T[], selectedKeys: string[]): T[] {
  if (items.length === 0 || selectedKeys.length === 0) return items;
  
  const selectedSet = new Set(selectedKeys);
  const unselected: T[] = [];
  const selected: T[] = [];
  
  // 分离选中和未选中的元素，保持各自的相对顺序
  for (const item of items) {
    if (selectedSet.has(item.key)) {
      selected.push(item);
    } else {
      unselected.push(item);
    }
  }
  
  // 选中的在前（底层），未选中的在后
  return [...selected, ...unselected];
}

/**
 * 检查元素是否可以上移
 */
export function canMoveUp<T extends LayerItem>(items: T[], selectedKeys: string[]): boolean {
  if (items.length === 0 || selectedKeys.length === 0) return false;
  const selectedSet = new Set(selectedKeys);
  // 如果最后一个元素不是选中的，说明有空间上移
  const lastItem = items[items.length - 1];
  return !selectedSet.has(lastItem.key);
}

/**
 * 检查元素是否可以下移
 */
export function canMoveDown<T extends LayerItem>(items: T[], selectedKeys: string[]): boolean {
  if (items.length === 0 || selectedKeys.length === 0) return false;
  const selectedSet = new Set(selectedKeys);
  // 如果第一个元素不是选中的，说明有空间下移
  const firstItem = items[0];
  return !selectedSet.has(firstItem.key);
}
