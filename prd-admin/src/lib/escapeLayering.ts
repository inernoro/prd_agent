/**
 * Escape 只关最上面那一层。
 *
 * 挂在 document / window 上听 Escape 的浮层，如果内部还会打开 Radix 弹窗（知识选择、
 * 回滚确认、驳回原因等），就会收到同一次按键：Radix 在捕获阶段处理它并 preventDefault，
 * 事件照样冒泡上来。不看 defaultPrevented 的话，用户按一次 Escape 只想关掉里面那一层，
 * 外面整层连同还没保存的输入一起被关掉。
 *
 * 判据只此一份：同样的条件在两个浮层里各写一遍，就是下一次只修好其中一个的起点。
 */
export function shouldCloseOnEscape(event: Pick<KeyboardEvent, 'key' | 'defaultPrevented'>): boolean {
  return event.key === 'Escape' && !event.defaultPrevented;
}
