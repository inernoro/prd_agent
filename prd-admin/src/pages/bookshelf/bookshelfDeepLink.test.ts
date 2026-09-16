/**
 * 藏书阁深链守卫。
 *
 * 为什么要有：`?vol=` 落错卷是**沉默**的——页面照常渲染，只是打开的不是你
 * 甩给别人的那一卷。人家点进去看到卷一，以为你发错了链接。这类「删掉不会红」
 * 的接线必须有判据（predicate-and-wiring-discipline 形状 2）。
 *
 * 判据锚在真实的卷 id 上：痛点药方表里每条 volumeId 都必须能被深链解析出来，
 * 否则甩出去的链接就是死的。
 */
import { describe, it, expect } from 'vitest';
import { VOLUMES, PAIN_REMEDIES } from '@/lib/bookshelf/catalog';
// 导入页面**实际在用**的那份解析规则。第一版这里复刻了一份，结果把实现改坏
// 测试照样全绿——判据只能证明副本自洽，证明不了实现对。
import { resolveVolumeFromUrl } from './BookshelfPage';

describe('深链 ?vol= 解析', () => {
  it('每一卷的 id 都能被解析出来 —— 七条链接没有一条是死的', () => {
    VOLUMES.forEach((v) => {
      expect(resolveVolumeFromUrl(v.id), `卷「${v.name}」的深链解析不出来`).toBe(v.id);
    });
  });

  it('痛点药方表里每条指向的卷都能深链直达', () => {
    PAIN_REMEDIES.forEach((r) => {
      expect(resolveVolumeFromUrl(r.volumeId), `痛点「${r.quote}」的深链是死的`).toBe(r.volumeId);
    });
  });

  it('未知 vol 回落到卷一，不抛错也不白屏', () => {
    expect(resolveVolumeFromUrl('vol-not-exist')).toBe(VOLUMES[0].id);
    expect(resolveVolumeFromUrl('')).toBe(VOLUMES[0].id);
    expect(resolveVolumeFromUrl(null)).toBe(VOLUMES[0].id);
  });

  it('页面初始化用的就是这份规则，不是另一份复刻', async () => {
    const src = (await import('./BookshelfPage.tsx?raw')).default;
    // 初始化与 URL 跟随都必须走 resolveVolumeFromUrl；谁在页面里另写一遍三元
    // 判断，这条就红。
    expect(src).toContain('resolveVolumeFromUrl(volFromUrl)');
    expect(src).not.toContain('volFromUrl && findVolume(volFromUrl) ? volFromUrl');
  });
});
