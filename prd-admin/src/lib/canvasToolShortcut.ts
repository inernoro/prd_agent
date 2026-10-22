export type CanvasToolShortcut = 'select' | 'hand';

type CanvasToolShortcutEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey'
>;

/**
 * 解析画布工具快捷键。Shift 仅用于输入大写字母，不改变工具语义。
 */
export function resolveCanvasToolShortcut(
  event: CanvasToolShortcutEvent,
): CanvasToolShortcut | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;

  if (event.key === 'h' || event.key === 'H' || event.code === 'KeyH') return 'hand';
  if (event.key === 'v' || event.key === 'V' || event.code === 'KeyV') return 'select';
  return null;
}
