import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { VOLUMES } from '@/lib/bookshelf/catalog';
import { selectedBookFromUrl, selectedVolumeFromUrl } from '../mobile/BookshelfMobile';

/**
 * 精读稿那一屏的守卫。
 *
 * 藏书阁改版的要害是「系统产出内容，用户消费」——在它之前用户点两下只能对着
 * 一个输入框。这组判据盯的就是这条链路别退回去：书页要真的存在、真的会去取稿子、
 * 卷页要真的能走到它。
 */

const DIR = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(DIR, rel), 'utf-8');

describe('?book= 解析', () => {
  const vol = VOLUMES[0];

  it('认得出这一卷里的书', () => {
    const book = vol.books[0];
    expect(selectedBookFromUrl(vol, book.id)?.id).toBe(book.id);
  });

  it('没有 book 参数时返回 null', () => {
    expect(selectedBookFromUrl(vol, null)).toBeNull();
  });

  /*
   * 这条是判据宽窄的分水岭：只按 id 全局找的话，
   * `?vol=vol-boot&book=<卷四的书>` 会打开卷一的壳子装卷四的书，
   * 返回键回到一个它根本不属于的卷 —— 一条拼错的链接就能造出自相矛盾的页面。
   */
  it('别卷的书不算数，不跨卷认领', () => {
    const otherVolume = VOLUMES.find((v) => v.id !== vol.id)!;
    const alien = otherVolume.books[0];
    expect(selectedBookFromUrl(vol, alien.id)).toBeNull();
  });

  it('没选中卷时不认任何书', () => {
    expect(selectedBookFromUrl(null, vol.books[0].id)).toBeNull();
  });

  it('认不出的卷仍然停在落地页（原有语义没被这次改动带偏）', () => {
    expect(selectedVolumeFromUrl('vol-不存在')).toBeNull();
  });
});

describe('精读稿接线', () => {
  const bookPage = read('mobile/MobileBook.tsx');

  /*
   * 删掉取稿子那一句，页面照样渲染、tsc 照样过、上面那些 URL 判据照样绿 ——
   * 剩下的是一屏只有书名作者的空壳。这条守卫就是为这种静默退化设的
   * （predicate-and-wiring-discipline 形状 2）。
   */
  it('书页真的会去取稿子，而不是只画个壳', () => {
    expect(bookPage.includes('getBookDigest('), '没有调用 getBookDigest，进页不会去看库里有没有现成的').toBe(true);
    expect(bookPage.includes('streamBookDigest('), '没有调用 streamBookDigest，没稿子时不会触发生成').toBe(true);
  });

  it('生成期间用 StreamingText 流式渲染，不是等完再一次性显示', () => {
    expect(bookPage.includes('StreamingText'), '流式输出必须走 StreamingText（prd-admin/CLAUDE.md 共享组件表）').toBe(true);
    expect(bookPage.includes('streaming={'), 'StreamingText 没接 streaming 状态，光标与最终 markdown 不会切换').toBe(true);
  });

  it('等待期写明在等什么、等了多久（规则 #6 禁止空白等待）', () => {
    expect(bookPage.includes('已等待'), '没有耗时提示，用户对着静止界面不知道还要多久').toBe(true);
  });

  it('卷页的书行能走到书页', () => {
    const volumePage = read('mobile/MobileVolume.tsx');
    expect(volumePage.includes('onOpenBook'), '卷页没有进书页的出口，书页成了孤岛').toBe(true);
  });
});
