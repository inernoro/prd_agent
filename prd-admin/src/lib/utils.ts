/**
 * 合并 class 名称，过滤 falsy 值
 * 类似 clsx/classnames 的简化版
 */
export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}
