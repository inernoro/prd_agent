import type { SizesByResolution } from '@/lib/imageAspectOptions';

/** 只在模型公布的尺寸中保留原比例；合法的手动选择不变。 */
export function fitLiteraryImageSize(size: string, catalog: SizesByResolution, sizesNotApplicable = false): string | null {
  if (sizesNotApplicable) return size;
  const sizes = Object.values(catalog).flat();
  if (sizes.some((x) => x.size === size)) return size;
  const dimensions = (value: string) => value.split('x').map(Number);
  const [w, h] = dimensions(size);
  if (!(w > 0 && h > 0)) return null;
  const matches = sizes.filter((x) => {
    const [a, b] = dimensions(x.size);
    return a > 0 && b > 0 && Math.abs((a / b) / (w / h) - 1) <= 0.02;
  });
  matches.sort((a, b) => {
    const area = (value: string) => dimensions(value).reduce((x, y) => x * y, 1);
    return Math.abs(Math.log(area(a.size) / (w * h))) - Math.abs(Math.log(area(b.size) / (w * h)));
  });
  return matches[0]?.size ?? null;
}

/** 单图错误与整批入队后拒绝都要保留，不能在 SSE 结束后被“未返回图片”覆盖。 */
export function imageRunFailure(event: Record<string, unknown>): string | null {
  if (event.type !== 'imageError' && event.type !== 'error') return null;
  return String(event.errorMessage || event.message || '图片生成失败，请选择其他模型后重试。');
}
